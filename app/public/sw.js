// Season Log のサービスワーカー: アプリ本体をキャッシュし、オフラインでも起動できるようにする。
// キャッシュ名は AGENTS.md の規則（season-log-YYYY.MM-rN）に従う。
// アプリ内のバージョン表示は、この CACHE_NAME から動的に取り出す（ここが唯一の正本）。
const CACHE_NAME = 'season-log-2026.11-r7';

// インストール時: 起動の入り口だけを先にキャッシュする
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(['/', '/index.html']))
      .then(() => self.skipWaiting())
  );
});

// 有効化時: 名前が変わった古いキャッシュを破棄する
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// 取得時: ページ遷移はネットワーク優先（更新を取りこぼさない）、
// それ以外の同一オリジンの取得はキャッシュ優先（オフラインでも開ける）
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // sw.js 自身は横取りしない（バージョン表示と更新検知を常に最新にするため）
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(hit => {
      if (hit) return hit;
      return fetch(request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return res;
      });
    })
  );
});
