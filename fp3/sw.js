/* Service Worker。アプリの殻（HTML/CSS/JS）だけをキャッシュする。
 * 問題データは IndexedDB にあり、ここでは扱わない。 */
const CACHE = 'fp3-drill-v2';
const ASSETS = ['./', './index.html', './app.js', './manifest.json',
                './icons/icon-192.png', './icons/icon-512.png',
                './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  // クエリ文字列付き（?v=<時刻> 等）はキャッシュに保存しない。毎回 URL が変わるため
  // 保存するとキャッシュが無制限に肥大化する。
  const hasQuery = new URL(e.request.url).search !== '';
  // HTML/JS は Network First（更新が即反映される）、失敗時のみキャッシュ
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if(!hasQuery){
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        }
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
