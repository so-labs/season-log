// Season Log コア — 変換ロジック（データ形式 v2）。
//
// 形式 v2（2026-11-14、データモデルの吟味を経て決定）:
//  - 中止は廃止し、非表示に置き換えた: 「残さずに消す」ではなく
//    「持ったまま、ただ見せない」という軽くて可逆なフラグ。
//    （旧Excelの ❌ は Phase 0 の移行時に非表示へ変換した。）
//  - 登録日時 / 更新日時は持たない（アプリ側で必要がなく、2つの日付項目と
//    保存済みの表示順で実際の用途をまかなえる）。
//  - CSVのフラグは記号（★✔❌▲）でなく 0/1 の数値にした。Shift-JIS の
//    書き出しで記号が静かに壊れる事故を防ぐため。Excel 側の見た目は
//    条件付き書式で付けられる。
//  - 未読列は形式から落とした: 表示時に常に（最大 − 進捗）で計算し、保存しない。
//    （v1ファイルに列が残っていても読み込める。値は無視する。）
//  - v1ファイルも読み続けられる: v1 CSV（記号フラグ・中止列・日時列）と
//    v1 JSON（isDropped、createdAt/updatedAt）は、読み込み時に
//    normalizeWork() で移行する。
//
// Phase 0 で検証済みのロジックから不変の点:
//  - 進捗は10倍した整数で保持する（11.1 -> 111）。null は null のまま
//  - 同一性は ID のみで判定し、同名タイトルを許容する
//  - 進捗 > 最大 を許容する。残りの表示は0未満にならないよう丸める
//  - 最大の空欄は「未確認」（null）を意味し、0 とは区別する
//
// Phase 0 の移行で使った旧Excel形式の変換は、移行完了後の2026-11-14に
// 削除した。現在の正本形式は、アプリ自身の CSV/JSON のみ。

export const SCHEMA_VERSION = 2;

export interface Work {
  id: string;
  title: string;
  category: string;
  unit: string;
  progressX10: number | null;
  maxX10: number | null;
  favorite: boolean;
  isCompleted: boolean;
  isHidden: boolean;
  hasAdult: boolean;
  lastCheckedDate: string | null; // YYYY-MM-DD
  lastProgressDate: string | null; // YYYY-MM-DD
  memo: string;
}

export interface BackupFile {
  schemaVersion: number;
  works: Work[];
}

export const NEW_CSV_HEADERS = [
  'ID', 'タイトル', 'カテゴリ', '進捗単位', '進捗', '最大',
  'お気に入り', '完結', 'アダルト', '非表示',
  '最終チェック日', '最終進捗日', 'メモ',
] as const;

/**
 * 旧形式の作品オブジェクトを現行形式へ移行する:
 * v1 の isDropped は isHidden へ、日時フィールドは除去し、
 * 欠けたフィールドは既定値で補う。v1 JSON、v1時代に保存された
 * IndexedDB の行、および安全策として使う。
 */
export function normalizeWork(raw: Record<string, unknown>): Work {
  const legacy = raw as { isDropped?: unknown };
  return {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? ''),
    category: String(raw.category ?? ''),
    unit: String(raw.unit ?? ''),
    progressX10: (raw.progressX10 as number | null) ?? null,
    maxX10: (raw.maxX10 as number | null) ?? null,
    favorite: raw.favorite === true,
    isCompleted: raw.isCompleted === true,
    isHidden: raw.isHidden === true || legacy.isDropped === true,
    hasAdult: raw.hasAdult === true,
    lastCheckedDate: (raw.lastCheckedDate as string | null) ?? null,
    lastProgressDate: (raw.lastProgressDate as string | null) ?? null,
    memo: String(raw.memo ?? ''),
  };
}

/** バッファを BOM で判定してデコードする。Excel の「Unicode テキスト」は UTF-16、CSV は UTF-8。 */
export function decodeTextBuffer(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  return new TextDecoder('utf-8').decode(buf);
}

// ---------- 10倍整数 ----------

/** 小数文字列（"11.1" | "11" | ""）を10倍整数または null に変換する。文字列で処理し、浮動小数点は使わない。 */
export function parseX10(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  if (s === '') return null;
  const m = /^(-?)(\d+)(?:\.(\d))?$/.exec(s);
  if (!m) throw new Error(`進捗として読めない値です: "${text}" (小数第1位まで)`);
  const v = Number(m[2]) * 10 + (m[3] ? Number(m[3]) : 0);
  return m[1] === '-' ? -v : v;
}

/** 10倍整数または null を表示文字列（"11.1" | "11" | ""）に戻す。 */
export function formatX10(x10: number | null | undefined): string {
  if (x10 === null || x10 === undefined) return '';
  const sign = x10 < 0 ? '-' : '';
  const a = Math.abs(x10);
  const intPart = Math.floor(a / 10);
  const frac = a % 10;
  return frac === 0 ? `${sign}${intPart}` : `${sign}${intPart}.${frac}`;
}

/** 表示・書き出し用の残り: 最大 − 進捗。0未満は0に丸め、どちらかが null なら null。 */
export function unreadX10(work: Pick<Work, 'progressX10' | 'maxX10'>): number | null {
  if (work.progressX10 === null || work.maxX10 === null) return null;
  return Math.max(0, work.maxX10 - work.progressX10);
}

// ---------- タイトルの類似チェック（新規登録時の注意喚起用） ----------

/**
 * 比較用にタイトルを正規化する: 全角半角と大文字小文字を統一し、空白と記号を取り除く。
 * 「〇〇物語」と「〇〇物語！」のような表記ゆれを、同じ土俵で比べられるようにするため。
 */
export function normalizeTitleForCompare(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function levenshtein(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 正規化したタイトル同士の類似度（0〜1。1が完全一致）。 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitleForCompare(a);
  const nb = normalizeTitleForCompare(b);
  if (na === '' || nb === '') return 0;
  if (na === nb) return 1;
  const dist = levenshtein([...na], [...nb]);
  let score = 1 - dist / Math.max(na.length, nb.length);
  // 一方が他方を含む場合（副題や続編表記の有無など）は、短い側が3文字以上あれば候補に含める。
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length >= 3 && longer.includes(shorter)) score = Math.max(score, 0.8);
  return score;
}

/** 入力タイトルに似た既存作品を、類似度の高い順に最大 limit 件返す（同点は保存順）。 */
export function findSimilarTitles(works: Work[], title: string, limit = 3): Work[] {
  if (normalizeTitleForCompare(title).length < 2) return [];
  return works
    .map(w => ({ w, score: titleSimilarity(title, w.title) }))
    .filter(x => x.score >= 0.8)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(x => x.w);
}

// ---------- アプリ内編集（進捗ボタン・日付ルール） ----------

/** ローカルタイムゾーンでの今日を YYYY-MM-DD 形式で返す。 */
export function todayLocal(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 進捗ボタン。deltaX10 は -10, -1, +1, +10 のいずれか。
 * 整数ステップ（±1）は、まず現在の整数部に合わせる: 10.3 +1 -> 11、
 * 10.3 -1 -> 9。小数ステップ（±0.1）は小数部を保つ。結果は0未満にせず、
 * UI上の便宜として、現在値が最大を超えていない場合に限り最大で頭打ちにする。
 * 値が実際に変わったときだけ最終進捗日を今日にし、変わらなければ
 * 作品をそのまま（同じオブジェクトで）返す。
 */
export function stepProgress(work: Work, deltaX10: number, today: string): Work {
  const cur = work.progressX10 ?? 0;
  let next: number;
  if (deltaX10 === 10 || deltaX10 === -10) {
    next = (Math.floor(cur / 10) + (deltaX10 > 0 ? 1 : -1)) * 10;
  } else {
    next = cur + deltaX10;
  }
  if (next < 0) next = 0;
  if (work.maxX10 !== null && cur <= work.maxX10 && next > work.maxX10) next = work.maxX10;
  if (next === cur) return work;
  return {
    ...work,
    progressX10: next,
    lastProgressDate: today,
    // 空欄の最終チェック日は進捗日で埋める。手元の分を進めたなら、
    // その日に確認も済んだはずだ、という扱い。
    lastCheckedDate: work.lastCheckedDate ?? today,
  };
}

/** 残りあり: 進捗が既知の最大に届いていない。 */
export function hasUnread(work: Work): boolean {
  return work.maxX10 !== null && work.progressX10 !== null && work.progressX10 < work.maxX10;
}

/**
 * 追いつき: 連載中の作品で、進捗が最大に達している。
 * 判定は本人のフラグと数値をそのまま正とする — 進捗0/最大0でも、
 * データがそうなっていれば追いつきとして扱う（2026-11-14、本人の決定）。
 */
export function isCaughtUp(work: Work): boolean {
  return !work.isCompleted && work.maxX10 !== null && work.progressX10 === work.maxX10;
}

/** 完了: 完結していて、進捗が最大に達している。 */
export function isFinishedReading(work: Work): boolean {
  return work.isCompleted && work.maxX10 !== null && work.progressX10 === work.maxX10;
}

/** 「確認」操作: 新しい分が出ているかを確認し、最終チェック日だけを更新する。 */
export function markChecked(work: Work, today: string): Work {
  return work.lastCheckedDate === today ? work : { ...work, lastCheckedDate: today };
}

/**
 * 編集フォーム保存時の日付自動更新。進捗（または最大）が変わり、
 * 対応する日付欄を手で編集していない場合、その日付を今日にする。
 * 手編集した日付は常に優先する。
 */
export function applyEdits(original: Work, draft: Work, today: string): Work {
  const out = { ...draft };
  if (draft.progressX10 !== original.progressX10 && draft.lastProgressDate === original.lastProgressDate) {
    out.lastProgressDate = today;
  }
  if (draft.maxX10 !== original.maxX10 && draft.lastCheckedDate === original.lastCheckedDate) {
    out.lastCheckedDate = today;
  }
  // 進捗ボタンと同じ補完ルール: 進捗が動き、最終チェック日が空欄で
  // （かつ手編集されていない）場合、確定した進捗日で埋める。
  if (draft.progressX10 !== original.progressX10
    && draft.lastCheckedDate === original.lastCheckedDate
    && out.lastCheckedDate === null && out.lastProgressDate !== null) {
    out.lastCheckedDate = out.lastProgressDate;
  }
  return out;
}

// ---------- 最小限のCSV処理（引用符、埋め込みのカンマ・引用符・改行、CRLF、BOMに対応） ----------

export function parseCsv(text: string, delimiter: string = ','): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function csvField(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return '\uFEFF' + rows.map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

// ---------- 作品配列 → 新形式CSV / JSON ----------

const flag = (b: boolean) => (b ? '1' : '0');

export function worksToCsv(works: Work[]): string {
  const rows: unknown[][] = [[...NEW_CSV_HEADERS]];
  for (const w of works) {
    rows.push([
      w.id, w.title, w.category, w.unit,
      formatX10(w.progressX10), formatX10(w.maxX10),
      flag(w.favorite), flag(w.isCompleted), flag(w.hasAdult), flag(w.isHidden),
      w.lastCheckedDate ?? '', w.lastProgressDate ?? '', w.memo ?? '',
    ]);
  }
  return toCsv(rows);
}

export function worksToJson(works: Work[]): string {
  const backup: BackupFile = { schemaVersion: SCHEMA_VERSION, works };
  return JSON.stringify(backup, null, 2);
}

export function worksFromJson(jsonText: string): Work[] {
  const data = JSON.parse(jsonText) as BackupFile;
  if (data.schemaVersion !== 1 && data.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`未対応の schemaVersion: ${data.schemaVersion}`);
  }
  // v1 の作品は isDropped / createdAt / updatedAt を持つ: normalizeWork で移行する。
  return (data.works as unknown as Record<string, unknown>[]).map(normalizeWork);
}

// ---------- 新形式CSV → 作品配列（v2 の数値フラグと v1 の記号フラグの両方を受ける） ----------

/** フラグのセル: v2 は "1"/"0"、v1 は記号（★/✔/❌/▲）。両方を受ける。 */
function parseFlagCell(v: string): boolean {
  const s = v.trim();
  return s === '1' || s === '★' || s === '✔' || s === '❌' || s === '▲';
}

export function parseNewCsv(text: string): Work[] {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex(r => r.includes('ID') && r.includes('タイトル'));
  if (headerIdx === -1) throw new Error('新形式CSVの見出し行が見つかりません');
  const header = rows[headerIdx];
  const col = (name: string) => header.indexOf(name);
  // 必須の見出しはすべて揃っていること: 列が欠けたファイルは
  // 空読みせず、必ず取込を止める（Shift-JIS 事故の教訓）。
  // 非表示列は、v1 の見出し「中止」でもよい。
  const required = ['ID', 'タイトル', 'カテゴリ', '進捗単位', '進捗', '最大', 'お気に入り', '完結', 'アダルト', '最終チェック日', '最終進捗日', 'メモ'];
  const missing = required.filter(name => col(name) === -1);
  if (col('非表示') === -1 && col('中止') === -1) missing.push('非表示');
  if (missing.length > 0) throw new Error(`新形式CSVに必要な見出しがありません: ${missing.join('、')}`);
  const works: Work[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every(c => c === '')) continue;
    const get = (name: string) => { const idx = col(name); return idx >= 0 && idx < r.length ? r[idx] : ''; };
    const getAny = (...names: string[]) => {
      for (const n of names) { const idx = col(n); if (idx >= 0 && idx < r.length) return r[idx]; }
      return '';
    };
    works.push(normalizeWork({
      id: get('ID'),
      title: get('タイトル').trim(),
      category: get('カテゴリ'),
      unit: get('進捗単位'),
      progressX10: parseX10(get('進捗')),
      maxX10: parseX10(get('最大')),
      // 未読列は取込時に無視する（表示時に再計算する）
      favorite: parseFlagCell(get('お気に入り')),
      isCompleted: parseFlagCell(get('完結')),
      isHidden: parseFlagCell(getAny('非表示', '中止')), // v1 の見出しは「中止」
      hasAdult: parseFlagCell(get('アダルト')),
      lastCheckedDate: get('最終チェック日').trim() || null,
      lastProgressDate: get('最終進捗日').trim() || null,
      memo: get('メモ'),
      // v1 の日時列（登録日時/更新日時）は、読み込んで捨てる。
    } as unknown as Record<string, unknown>));
  }
  return works;
}

// ---------- 差分比較（取込マージの変更判定と、開発時の往復検証に使う） ----------

const FIELDS = ['id', 'title', 'category', 'unit', 'progressX10', 'maxX10',
  'favorite', 'isCompleted', 'isHidden', 'hasAdult',
  'lastCheckedDate', 'lastProgressDate', 'memo'] as const;

export interface WorkDiff {
  kind?: string;
  message?: string;
  index?: number;
  title?: string;
  field?: string;
  before?: unknown;
  after?: unknown;
}

/** 厳密な比較: 書き出しから再取込までの往復では、差分0が必須。 */
export function diffWorks(before: Work[], after: Work[]): WorkDiff[] {
  const diffs: WorkDiff[] = [];
  if (before.length !== after.length) diffs.push({ kind: 'row-count', message: `行数が違います: ${before.length} -> ${after.length}` });
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i++) {
    for (const f of FIELDS) {
      if (before[i][f] !== after[i][f]) {
        diffs.push({ index: i, title: before[i].title, field: f, before: before[i][f], after: after[i][f] });
      }
    }
  }
  return diffs;
}
