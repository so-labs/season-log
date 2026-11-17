// 引き継ぎコードの中継サーバー（Cloudflare Pages Functions）。
// 送り側が預けたJSONバックアップを KV に最大10分だけ置き、受け取り側が
// コードで1回だけ取得できるようにする、通り道だけの実装。
// データを恒常的に保持することはしない（受け取り成功で即削除、
// 受け取られなくても有効期限で自動削除）。
// KV のバインド名は HANDOVER_KV（Pages プロジェクトの Functions 設定で
// KV 名前空間を接続する）。未接続のときは 501 で「未設定」を返す。
// KV は結果整合性のため、書き込みが別の場所から見えるまで最大で
// 数十秒かかることがある。受け取り側は見つからない場合に数回
// リトライして吸収する前提（handover.ts 側の実装を参照）。

/** KV 名前空間の最小限の型（Workers の型定義を持ち込まないため） */
interface HandoverKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Env {
  HANDOVER_KV?: HandoverKv;
}

interface PagesContext {
  request: Request;
  env: Env;
  params: { action?: string };
}

/** コードの有効期限（秒）: 10分 */
const TTL_SECONDS = 10 * 60;
/** 預けられるデータの上限（バイト）。実データは約350KB */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** コードに使う文字（紛らわしい 0・1・I・L・O を除いた31文字） */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/** コードは英数字10文字 */
const CODE_LENGTH = 10;
const CODE_PATTERN = /^[2-9A-HJKMNP-Z]{10}$/;
/** 同じ接続元からの受け取り失敗がこの回数を超えたら、窓の間は止める */
const MAX_FAILURES = 30;

const codeKey = (code: string) => `code:${code}`;
const attemptsKey = (ip: string) => `attempts:${ip}`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse(status, { error: message });
}

/** コードを生成する（暗号論的乱数を使い、剰余の偏りが出ないよう棄却サンプリングする） */
function generateCode(): string {
  const chars: string[] = [];
  while (chars.length < CODE_LENGTH) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= 248) continue; // 31文字 × 8 = 248。これ以上は捨てて偏りをなくす
      chars.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
      if (chars.length === CODE_LENGTH) break;
    }
  }
  return chars.join('');
}

async function handleIssue(kv: HandoverKv, request: Request): Promise<Response> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return errorResponse(413, 'データが大きすぎるため、引き継ぎコードを発行できませんでした。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return errorResponse(400, 'Season LogのJSONバックアップではないため、発行できませんでした。');
  }
  const data = parsed as { schemaVersion?: unknown; works?: unknown };
  if (data === null || typeof data !== 'object' || data.schemaVersion !== 2 || !Array.isArray(data.works)) {
    return errorResponse(400, 'Season LogのJSONバックアップではないため、発行できませんでした。');
  }
  // 既存コードとの衝突を避けながら採番する。
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    if (await kv.get(codeKey(code)) !== null) continue;
    await kv.put(codeKey(code), text, { expirationTtl: TTL_SECONDS });
    return jsonResponse(200, {
      code,
      expiresAt: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
    });
  }
  return errorResponse(503, 'コードを発行できませんでした。もう一度お試しください。');
}

async function readCodeFromBody(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { code?: unknown };
    return typeof body.code === 'string' && CODE_PATTERN.test(body.code) ? body.code : null;
  } catch {
    return null;
  }
}

async function handleRedeem(kv: HandoverKv, request: Request): Promise<Response> {
  const code = await readCodeFromBody(request);
  if (code === null) return errorResponse(400, '10文字のコードを指定してください。');
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const attempts = attemptsKey(ip);
  const failures = Number.parseInt((await kv.get(attempts)) ?? '0', 10) || 0;
  if (failures >= MAX_FAILURES) {
    return errorResponse(429, '試行回数が上限に達しました。しばらく待ってからお試しください。');
  }
  const value = await kv.get(codeKey(code));
  if (value === null) {
    // 失敗回数を数える（総当たり対策）。窓は失敗のたびに10分へ伸びる。
    await kv.put(attempts, String(failures + 1), { expirationTtl: TTL_SECONDS });
    return errorResponse(404, 'コードが見つかりませんでした。期限切れか、既に使用済みの可能性があります。');
  }
  // 使ったら即失効: 返す前に消す（KVの削除反映が遅れた場合に二重に
  // 取得される余地は残るが、受け取り側の取り込みはID照合で冪等）。
  await kv.delete(codeKey(code));
  await kv.delete(attempts);
  return new Response(value, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function handleCancel(kv: HandoverKv, request: Request): Promise<Response> {
  const code = await readCodeFromBody(request);
  if (code === null) return errorResponse(400, '10文字のコードを指定してください。');
  // あったかどうかは明かさず、常に成功として返す（冪等）。
  await kv.delete(codeKey(code));
  return jsonResponse(200, { ok: true });
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const kv = context.env.HANDOVER_KV;
  if (!kv) {
    return errorResponse(501, '引き継ぎコードは現在利用できません（サーバー側の設定が未完了です）。');
  }
  switch (context.params.action) {
    case 'issue': return handleIssue(kv, context.request);
    case 'redeem': return handleRedeem(kv, context.request);
    case 'cancel': return handleCancel(kv, context.request);
    default: return errorResponse(404, '不明な操作です。');
  }
}
