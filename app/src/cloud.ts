// クラウド同期の汎用定義（プロバイダ非依存）。
// 同期先ごとの認証やAPIの違いは cloud-<プロバイダ>.ts 側に閉じ込め、
// 画面（App.tsx）はこのインターフェースだけを使う。将来別のクラウド
// （例: OneDrive）を足すときも、実装ファイルを追加して画面側の
// プロバイダ一覧に加えるだけで済むようにしてある。
// 同期を有効にできるのは常に1つのプロバイダだけ（排他利用）。
// 切り替えるときは、先に今のプロバイダとの接続を解除する。

/** 同期先プロバイダの識別子 */
export type CloudProviderId = 'google-drive';

/** クラウド上にある同期ファイルの情報 */
export interface CloudRemoteMeta {
  /** プロバイダ内でのファイルの識別子 */
  id: string;
  /** プロバイダ側の最終更新日時（ISO 8601） */
  updatedAt: string;
  /** バイト数（分からない場合は null） */
  size: number | null;
}

/** 同期先プロバイダが満たすインターフェース */
export interface CloudProvider {
  readonly id: CloudProviderId;
  /** 画面に表示する名前（例: Google Drive） */
  readonly label: string;
  /** 利用に必要な設定（環境変数など）が揃っているかどうか */
  isConfigured(): boolean;
  /** 接続する（必要なら認証画面が出る）。トークンはメモリ上にだけ持つ */
  connect(): Promise<void>;
  /** この端末での接続を解除する。クラウド上のファイルは消さない */
  disconnect(): void;
  /** この端末で接続済み（トークンが有効）かどうか */
  isConnected(): boolean;
  /** 同期ファイルがあればその情報を、なければ null を返す */
  findSyncFile(): Promise<CloudRemoteMeta | null>;
  /** 同期ファイルへ内容を書き込み、書き込み後の情報を返す */
  uploadSyncFile(content: string, existing: CloudRemoteMeta | null): Promise<CloudRemoteMeta>;
  /** 同期ファイルの内容を文字列で返す */
  downloadSyncFile(remoteId: string): Promise<string>;
}

/** 同期ファイル名（保存形式は通常のJSONバックアップと同一） */
export const CLOUD_SYNC_FILE_NAME = 'season-log.json';

// 同期に関する端末ローカルの記録は localStorage に置く（作品データには混ぜない）。
const CLOUD_PROVIDER_KEY = 'season-log:cloud-provider';
const CLOUD_LAST_SYNCED_KEY = 'season-log:cloud-last-synced-at';
const CLOUD_REMOTE_UPDATED_KEY = 'season-log:cloud-remote-updated-at';

/** 有効化されているプロバイダ（なければ null） */
export function getActiveCloudProviderId(): CloudProviderId | null {
  return localStorage.getItem(CLOUD_PROVIDER_KEY) === 'google-drive' ? 'google-drive' : null;
}

export function setActiveCloudProviderId(id: CloudProviderId | null): void {
  if (id === null) localStorage.removeItem(CLOUD_PROVIDER_KEY);
  else localStorage.setItem(CLOUD_PROVIDER_KEY, id);
}

/** この端末が最後に同期（保存または読み込み）した日時（ISO 8601、なければ null） */
export function getCloudLastSyncedAt(): string | null {
  return localStorage.getItem(CLOUD_LAST_SYNCED_KEY);
}

export function setCloudLastSyncedAt(iso: string | null): void {
  if (iso === null) localStorage.removeItem(CLOUD_LAST_SYNCED_KEY);
  else localStorage.setItem(CLOUD_LAST_SYNCED_KEY, iso);
}

/**
 * この端末が最後に把握した、クラウド側ファイルの更新日時（ISO 8601）。
 * 保存時にクラウド側の実物と比べ、食い違えば他の端末で更新された
 * 可能性があるため上書き確認を出す、という競合判定に使う。
 */
export function getCloudRemoteUpdatedAt(): string | null {
  return localStorage.getItem(CLOUD_REMOTE_UPDATED_KEY);
}

export function setCloudRemoteUpdatedAt(iso: string | null): void {
  if (iso === null) localStorage.removeItem(CLOUD_REMOTE_UPDATED_KEY);
  else localStorage.setItem(CLOUD_REMOTE_UPDATED_KEY, iso);
}

/** 接続解除時に、この端末の同期記録をすべて消す（クラウド上のファイルは消さない） */
export function clearCloudSyncState(): void {
  setActiveCloudProviderId(null);
  setCloudLastSyncedAt(null);
  setCloudRemoteUpdatedAt(null);
}

/** ISO日時を画面表示用（年月日 時:分）に整える */
export function formatCloudDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP', {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
