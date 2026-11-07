// 語学アプリ（Cascade から切り出し）の Service Worker。スコープは /cascade/lang/ のみ。
// ページとデータ JSON は通信優先（新しい動詞・新しい版をすぐ反映。オフラインならキャッシュ）。
// アイコンなどは、キャッシュにあればそれを返す。
// 同じオリジンの他アプリ（Cascade・fp3・kenchiku・ideas-app）のキャッシュは消さない。
const CACHE = 'lang-v1';
const PRECACHE = ['./', './index.html', './manifest.json', './icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('lang-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;            // GitHub API などは触らない

  const networkFirst = req.mode === 'navigate' || url.pathname.endsWith('.json') || url.pathname.endsWith('/');
  if (networkFirst) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? './' : req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
      }
      return res;
    }))
  );
});
