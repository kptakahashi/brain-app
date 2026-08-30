/* Service Worker — アプリ本体を端末に保持し、電波がなくても起動できるようにする。
 *
 * 事故防止の設計:
 *  - VERSION を上げると全ファイルを「まとめて」入れ替える(install時に一括取得)。
 *    個別に古い/新しいが混ざることが原理的に起きない。
 *  - HTMLはネット優先(3秒でタイムアウト→キャッシュ)。PCやGitHubに繋がる時は常に最新。
 *  - GitHub APIと音声Blobはキャッシュしない(アプリ側がIndexedDBで管理)。
 */
const VERSION = "v19";
const SHELL = "brain-shell-" + VERSION;
const FILES = [
  "./",
  "./index.html",
  "./style.css?v=19",
  "./app.js?v=19",
  "./gh.js?v=19",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return; // GitHub APIなどは素通し

  // HTML: ネット優先 → 落ちたらキャッシュ
  if (e.request.mode === "navigate") {
    e.respondWith(
      Promise.race([
        fetch(e.request),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
      ])
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html", { ignoreSearch: true }).then((r) => r || caches.match("./")))
    );
    return;
  }

  // それ以外(バージョン付き静的ファイル): キャッシュ優先
  e.respondWith(
    caches.match(e.request, { ignoreSearch: false }).then((hit) => hit || fetch(e.request))
  );
});
