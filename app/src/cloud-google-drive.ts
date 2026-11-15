// Google Drive への同期実装（cloud.ts の CloudProvider 実装）。
// 保存先はアプリ専用領域（appDataFolder）で、Drive の画面には表示されず、
// このアプリ以外からはアクセスできない。認証は Google Identity Services の
// トークン方式で、サーバーもクライアントシークレットも使わない。
// クライアントIDは公開情報だが、設定の変更や各自でのデプロイに備えて
// コードには書かず、環境変数 VITE_GOOGLE_CLIENT_ID から読み込む
// （ローカルでは app/.env.local、本番ではホスティング側の環境変数）。
// アクセストークンはメモリ上にだけ持ち、保存はしない。
import {
  CLOUD_SYNC_FILE_NAME,
  type CloudProvider,
  type CloudRemoteMeta,
} from './cloud';

const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const DRIVE_API_BASE = 'https://www.googleapis.com';

// ---------- Google Identity Services の最小限の型 ----------
interface GisTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}
interface GisTokenClient {
  requestAccessToken(params: { prompt: string }): void;
}
interface GisOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: GisTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): GisTokenClient;
  revoke(accessToken: string, done: () => void): void;
}
declare global {
  interface Window {
    google?: { accounts: { oauth2: GisOAuth2 } };
  }
}

// ---------- トークン管理（メモリ上のみ） ----------
let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let tokenClient: GisTokenClient | null = null;
let gisLoadPromise: Promise<void> | null = null;
// トークンクライアントのコールバックは生成時に固定されるため、
// 進行中のリクエストの解決先はこちらに差し替えて受け渡す。
let pendingTokenRequest: {
  resolve: (token: string) => void;
  reject: (error: Error) => void;
} | null = null;

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisLoadPromise) {
    gisLoadPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisLoadPromise = null;
        reject(new Error('Googleの認証ライブラリを読み込めませんでした。通信環境を確認してください。'));
      };
      document.head.appendChild(script);
    });
  }
  return gisLoadPromise;
}

async function requestAccessToken(): Promise<string> {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error('Google DriveのクライアントIDが設定されていません。環境変数 VITE_GOOGLE_CLIENT_ID を設定してください。');
  }
  if (accessToken !== null && Date.now() < accessTokenExpiresAt - 60_000) return accessToken;
  await loadGis();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error('Googleの認証ライブラリを利用できませんでした。');
  if (!tokenClient) {
    tokenClient = oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: response => {
        const pending = pendingTokenRequest;
        pendingTokenRequest = null;
        if (!pending) return;
        if (response.error || !response.access_token) {
          pending.reject(new Error('Googleアカウントの認証に失敗しました。'));
          return;
        }
        accessToken = response.access_token;
        accessTokenExpiresAt = Date.now() + (response.expires_in ?? 3600) * 1000;
        pending.resolve(accessToken);
      },
      error_callback: () => {
        const pending = pendingTokenRequest;
        pendingTokenRequest = null;
        pending?.reject(new Error('Googleアカウントの認証がキャンセルされました。'));
      },
    });
  }
  const request = new Promise<string>((resolve, reject) => {
    pendingTokenRequest = { resolve, reject };
  });
  // 空文字は「必要なら対話的に求める」の意味で、同意済みなら静かに再取得される。
  tokenClient.requestAccessToken({ prompt: '' });
  return request;
}

async function driveRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await requestAccessToken();
  const res = await fetch(`${DRIVE_API_BASE}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    // トークンが失効していたら破棄して、次回は再認証から始める。
    accessToken = null;
    accessTokenExpiresAt = 0;
    throw new Error('認証の有効期限が切れました。もう一度お試しください。');
  }
  return res;
}

interface DriveFileResource {
  id: string;
  modifiedTime: string;
  size?: string;
}

function toRemoteMeta(file: DriveFileResource): CloudRemoteMeta {
  return {
    id: file.id,
    updatedAt: file.modifiedTime,
    size: file.size !== undefined ? Number(file.size) : null,
  };
}

async function findSyncFile(): Promise<CloudRemoteMeta | null> {
  const query = encodeURIComponent(`name = '${CLOUD_SYNC_FILE_NAME}'`);
  const res = await driveRequest(
    `/drive/v3/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime%20desc`,
  );
  if (!res.ok) throw new Error(`クラウドのファイル一覧の取得に失敗しました（${res.status}）`);
  const data = (await res.json()) as { files?: DriveFileResource[] };
  const file = data.files?.[0];
  return file ? toRemoteMeta(file) : null;
}

async function uploadSyncFile(content: string, existing: CloudRemoteMeta | null): Promise<CloudRemoteMeta> {
  if (existing) {
    // 既存ファイルは内容だけを差し替える。
    const res = await driveRequest(
      `/upload/drive/v3/files/${existing.id}?uploadType=media&fields=id,modifiedTime,size`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content },
    );
    if (!res.ok) throw new Error(`クラウドへの保存に失敗しました（${res.status}）`);
    return toRemoteMeta((await res.json()) as DriveFileResource);
  }
  // 新規作成はメタデータと内容をまとめて送る（multipart）。
  const boundary = 'season-log-boundary';
  const metadata = JSON.stringify({
    name: CLOUD_SYNC_FILE_NAME,
    parents: ['appDataFolder'],
    mimeType: 'application/json',
  });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
    `--${boundary}--`;
  const res = await driveRequest(
    '/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime,size',
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
  );
  if (!res.ok) throw new Error(`クラウドへの保存に失敗しました（${res.status}）`);
  return toRemoteMeta((await res.json()) as DriveFileResource);
}

async function downloadSyncFile(remoteId: string): Promise<string> {
  const res = await driveRequest(`/drive/v3/files/${remoteId}?alt=media`);
  if (!res.ok) throw new Error(`クラウドからの読み込みに失敗しました（${res.status}）`);
  return res.text();
}

export const googleDriveProvider: CloudProvider = {
  id: 'google-drive',
  label: 'Google Drive',
  isConfigured() {
    return GOOGLE_CLIENT_ID !== '';
  },
  async connect() {
    await requestAccessToken();
  },
  disconnect() {
    const token = accessToken;
    accessToken = null;
    accessTokenExpiresAt = 0;
    if (token && window.google?.accounts?.oauth2) {
      try {
        window.google.accounts.oauth2.revoke(token, () => { /* 破棄結果は問わない */ });
      } catch { /* ライブラリ未読込時はメモリ上の破棄だけでよい */ }
    }
  },
  isConnected() {
    return accessToken !== null && Date.now() < accessTokenExpiresAt;
  },
  findSyncFile,
  uploadSyncFile,
  downloadSyncFile,
};
