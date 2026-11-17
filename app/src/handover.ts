// 引き継ぎコードのクライアント（サーバー側は functions/api/handover/）。
// 送り側はJSONバックアップを預けてコードを受け取り、受け取り側は
// コードでJSONを1回だけ取得する。サーバーにデータが残るのは最大10分で、
// 受け取りが完了した時点でも削除される（実験的機能）。
// サーバーの保存先（KV）は結果整合性のため、発行直後は別の場所から
// まだ見えないことがある。受け取りで「見つからない」が返った場合は、
// 少し待って自動でリトライして吸収する。

const API_BASE = '/api/handover';

/** 発行された引き継ぎコードと、その有効期限（ISO 8601） */
export interface IssuedHandover {
  code: string;
  expiresAt: string;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === 'string') return data.error;
  } catch { /* エラー本文が読めない場合は、状態コードで伝える */ }
  return `サーバーとの通信に失敗しました（${res.status}）`;
}

/** JSONバックアップを預けて、引き継ぎコードを発行する */
export async function issueHandover(content: string): Promise<IssuedHandover> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: content,
    });
  } catch {
    throw new Error('サーバーに接続できませんでした。通信環境を確認してください。');
  }
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as IssuedHandover;
}

/**
 * コードでJSONバックアップを受け取る（サーバー側では即削除される）。
 * 発行直後の反映待ちの可能性があるため、404のときだけ数回リトライする。
 */
export async function redeemHandover(code: string): Promise<string> {
  const maxAttempts = 3;
  const retryWaitMs = 2500;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    } catch {
      throw new Error('サーバーに接続できませんでした。通信環境を確認してください。');
    }
    if (res.ok) return res.text();
    if (res.status === 404 && attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, retryWaitMs));
      continue;
    }
    throw new Error(await readErrorMessage(res));
  }
}

/** 発行したコードを取り消す（失敗しても利用者には影響しないので、結果は問わない） */
export async function cancelHandover(code: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch { /* 取り消しはベストエフォート（期限でも自動的に消える） */ }
}
