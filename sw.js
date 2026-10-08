// 離線用：把 App 檔案存到手機。改版時把 VERSION 加 1，手機下次連上網路就會更新。
// 資料包存在 IndexedDB（app.js 處理），這裡只快取程式檔案；海報圖片看過的也會留著。
const VERSION = 'movieguide-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
const IMG = 'movieguide-img';

self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== IMG).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // 自己的檔案：先用快取，背景更新
  if (url.origin === location.origin) {
    e.respondWith(caches.open(VERSION).then(async cache => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || new Response('離線中', { status: 503 });
    }));
    return;
  }
  // 海報（開眼、TMDB）：看過的存起來，離線也看得到；最多留 150 張
  if (e.request.destination === 'image' && /atmovies\.com\.tw|image\.tmdb\.org|ytimg\.com/.test(url.hostname)) {
    e.respondWith(caches.open(IMG).then(async cache => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === 'opaque') {
        cache.put(e.request, res.clone());
        cache.keys().then(ks => { if (ks.length > 150) ks.slice(0, ks.length - 150).forEach(k => cache.delete(k)); });
      }
      return res;
    }).catch(() => fetch(e.request)));
  }
});
