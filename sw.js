const CACHE = 'cascade-v9';
const PRECACHE = ['./index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// HTML / ナビゲーションは Network First（常に最新を取得、オフライン時のみキャッシュへフォールバック）。
// → コードを更新すれば、アプリを開き直すだけで最新が反映され、登録し直しは不要。
// その他の静的アセット（フォント・アイコン等）は Cache First（高速・オフライン対応）。
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const req = e.request;
  const url = new URL(req.url);

  // 一級建築士ドリル（/kenchiku/）と FP3ドリル（/fp3/）は自前の Service Worker を
  // 持つので一切触らない。ここで除外しないと (1) その JS が Cache First で固定され
  // 更新が届かなくなり、(2) 下の HTML 分岐がドリルのページを './index.html'
  // （= cascade 本体のキー）に上書き保存してしまい、オフライン時に cascade が
  // ドリル画面になる。
  if (url.pathname.includes('/kenchiku/') || url.pathname.includes('/fp3/')) return;

  const isHTML = req.mode === 'navigate'
    || req.destination === 'document'
    || url.pathname.endsWith('/')
    || url.pathname.endsWith('/index.html');

  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', clone));
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match(req)))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          caches.open(CACHE).then(c => c.put(req, res.clone()));
        }
        return res;
      });
    })
  );
});
