/* Service Worker — アプリ本体を端末に保持し、電波がなくても起動できるようにする。
 *
 * 事故防止の設計:
 *  - VERSION を上げると全ファイルを「まとめて」入れ替える(install時に一括取得)。
 *    個別に古い/新しいが混ざることが原理的に起きない。
 *  - HTMLはネット優先(3秒でタイムアウト→キャッシュ)。PCやGitHubに繋がる時は常に最新。
 *  - GitHub APIと音声Blobはキャッシュしない(アプリ側がIndexedDBで管理)。
 */
const VERSION = "v21";
const SHELL = "brain-shell-" + VERSION;
const FILES = [
  "./",
  "./index.html",
  "./style.css?v=21",
  "./app.js?v=21",
  "./gh.js?v=21",
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

  // Android の共有(Web Share Target)。Kindle のハイライト共有・ノートブックのエクスポートを受け取り、
  // 一時的に Cache に置いてアプリに引き渡す(アプリ側 handleSharedIntake)。解析はしない。
  if (e.request.method === "POST" && url.pathname.endsWith("/share")) {
    e.respondWith(
      (async () => {
        const fd = await e.request.formData();
        let text = String(fd.get("text") || "");
        let format = "text";
        let fileName = "";
        for (const f of fd.getAll("files")) {
          if (f && typeof f.text === "function" && f.size) {
            text = await f.text();
            format = /\.html?$/i.test(f.name || "") || /^text\/html/.test(f.type || "") ? "html" : "text";
            fileName = f.name || "";
            break;
          }
        }
        const payload = {
          title: String(fd.get("title") || ""),
          url: String(fd.get("url") || ""),
          text,
          format,
          fileName,
          receivedAt: new Date().toISOString(),
        };
        const c = await caches.open("brain-share");
        await c.put("./share-pending", new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }));
        return Response.redirect("./?share=1", 303);
      })()
    );
    return;
  }

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
