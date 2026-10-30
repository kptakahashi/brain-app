/* Brain — スマホ完結版 PWA
 *
 * サーバーなし。GitHubリポジトリを直接読み書きし、AIが要る処理は
 * 「依頼(タスク)」としてリポジトリに置く。Claude Codeのクラウドセッション
 * (定期実行 or スマホから手動)がそれを処理してVaultに書き戻す。
 *
 * 鍛える・聴く は完全にローカルで動くため、電波がなくても使える。
 */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------------------------------------------------------- リポジトリ内の配置
const P = {
  cards: "brain/cards.json",
  playlist: "brain/playlist.json",
  audioDir: "brain/audio",
  pending: "brain/tasks/pending",
  done: "brain/tasks/done",
  inbox: "vault/メモ/_inbox",
  vault: "vault/メモ",
  sessions: "vault/メモ/80_セッション",
  research: "vault/メモ/70_事例/リサーチ",
  newsDir: "brain/news",
  newsLatest: "brain/news/latest.json",
  newsFeedback: "brain/news/feedback",
};

// ---------------------------------------------------------------- ローカル保存(IndexedDB)
const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open("brain-local", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
        if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      let out;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => (out = req.result);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  }
  return {
    get: (k) => tx("kv", "readonly", (s) => s.get(k)),
    set: (k, v) => tx("kv", "readwrite", (s) => s.put(v, k)),
    qAdd: (item) => tx("queue", "readwrite", (s) => s.add(item)),
    qAll: () => tx("queue", "readonly", (s) => s.getAll()),
    qDel: (id) => tx("queue", "readwrite", (s) => s.delete(id)),
    audioGet: (k) => tx("audio", "readonly", (s) => s.get(k)),
    audioSet: (k, blob) => tx("audio", "readwrite", (s) => s.put(blob, k)),
    audioDel: (k) => tx("audio", "readwrite", (s) => s.delete(k)),
    audioKeys: () => tx("audio", "readonly", (s) => s.getAllKeys()),
  };
})();

// ---------------------------------------------------------------- 汎用
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg, ms = 3400) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), ms);
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function fmtTime(iso) {
  return iso ? String(iso).replace("T", " ").slice(5, 16) : "";
}
const EMPTY = (m) => `<div class="empty">${esc(m)}</div>`;

// ---------------------------------------------------------------- 状態
let view = "news";
let captureKind = "input";
let learnStyle = "dialogue";
let speed = parseFloat(localStorage.getItem("brain_speed") || "1.2");
let cards = [];          // トレーナーカード(ローカルキャッシュ)
let playlist = [];
let session = null;
let pendingTaskCount = 0;

// ---------------------------------------------------------------- 起動
async function boot() {
  if (!GH.configured()) {
    $("#setup").hidden = false;
    return;
  }
  $("#setup").hidden = true;
  $("#app-header").hidden = false;
  $("#main").hidden = false;
  $("#tabbar").hidden = false;
  switchView(view);
  await loadLocalCaches();
  syncAll();
  handleSharedIntake();
}

// ---------------------------------------------------------------- 共有で届いたもの(Kindle ハイライト)
/** Service Worker が Cache に置いた共有データを取り出し、確認画面を出す */
async function handleSharedIntake() {
  const u = new URL(location.href);
  if (!u.searchParams.has("share")) return;
  history.replaceState(null, "", "./");
  let data = null;
  try {
    const c = await caches.open("brain-share");
    const r = await c.match("./share-pending");
    if (r) {
      data = await r.json();
      await c.delete("./share-pending");
    }
  } catch {}
  if (!data || !(data.text || "").trim()) return toast("共有の中身を受け取れませんでした。もう一度共有してください。", 5000);
  showKindleConfirm(data);
}

/** 共有テキスト/HTML から書名・著者・件数を推定して表示用にする(保存はワーカーが行う) */
function guessBook(data) {
  const t = data.text || "";
  let book, author, count;
  if (data.format === "html") {
    const bt = t.match(/class="bookTitle"[^>]*>([^<]+)</);
    const au = t.match(/class="authors"[^>]*>([^<]+)</);
    book = bt ? bt[1].trim() : "";
    author = au ? au[1].trim() : "";
    count = (t.match(/class="noteText"/g) || []).length || 1;
  } else {
    // Kindle アプリの共有: 「"引用" — 著者『書名』」や「…(書名)」、amazon リンクなど。取れなければ空のまま
    const m1 = t.match(/[『「]([^』」]{2,60})[』」]/);
    const m2 = t.match(/[—–-]\s*([^\n]{2,60})$/m);
    book = m1 ? m1[1] : "";
    author = "";
    if (!book && m2) book = m2[1].trim();
    count = Math.max(1, (t.match(/\n\s*\n/g) || []).length);
  }
  if (!book && data.title) book = data.title.trim();
  return { book, author, count };
}

function showKindleConfirm(data) {
  const g = guessBook(data);
  const preview = (data.format === "html" ? data.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : data.text).slice(0, 240);
  $("#modal-title").textContent = "読書ハイライトを取り込む";
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  $("#modal-body").innerHTML = `
    <p class="hint">Kindle から共有された内容を AI が読み、関連するフレームの「参考」として Vault に入れます。書名が違えば直してください。</p>
    <label class="fld"><span>書名</span><input id="kb-book" value="${esc(g.book)}" placeholder="書名"></label>
    <label class="fld"><span>著者(任意)</span><input id="kb-author" value="${esc(g.author)}" placeholder="著者"></label>
    <div class="meta">${data.format === "html" ? "ノートブック(HTML)" : "共有テキスト"} ・ 約${g.count}件 ・ ${(data.text.length / 1000).toFixed(1)}KB</div>
    <div class="card"><div class="meta">${esc(preview)}…</div></div>
    <div class="btn-row">
      <button class="primary" data-action="kindle-send">取り込みを依頼</button>
      ${data.format === "text" ? `<button class="ghost" data-action="kindle-stash">ためておく</button>` : ""}
      <button class="ghost" data-action="modal-close">やめる</button>
    </div>
    ${data.format === "text" ? `<p class="hint">「ためておく」: 同じ本のハイライトを端末に貯め、記録タブから1回で依頼できます（出版社のエクスポート上限を避ける方法）。</p>` : ""}`;
  $("#modal").hidden = false;
  window._sharedKindle = data;
}

// ---- 読書バスケット（同じ本のハイライトを端末にためて一括依頼。電波不要）
async function basketGet() { return (await DB.get("kindleBasket")) || {}; }
async function basketAdd(book, author, text) {
  const b = await basketGet();
  const key = book || "書名不明";
  b[key] = b[key] || { author: author || "", items: [] };
  if (author && !b[key].author) b[key].author = author;
  if (!b[key].items.some((i) => i.text === text)) b[key].items.push({ text, at: new Date().toISOString() });
  await DB.set("kindleBasket", b);
  return b[key].items.length;
}
async function basketFlush(book) {
  const b = await basketGet();
  const e = b[book];
  if (!e || !e.items.length) return toast("ためたハイライトがありません");
  const text = e.items.map((i) => i.text.trim()).join("\n\n---\n\n");
  delete b[book];
  await DB.set("kindleBasket", b);
  await createTask("kindle", book.slice(0, 40), { book, author: e.author || "", asin: "", text, format: "text", source: "basket", count: e.items.length });
}
async function renderBasket() {
  const el = $("#kindle-basket");
  if (!el) return;
  const b = await basketGet();
  const books = Object.keys(b).filter((k) => b[k].items.length);
  if (!books.length) return (el.innerHTML = "");
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  el.innerHTML =
    `<h2>ためている読書ハイライト</h2>` +
    books
      .map(
        (k) => `<div class="card">
        <div class="title">『${esc(k)}』 <span class="meta">${b[k].items.length}件${b[k].author ? " ・ " + esc(b[k].author) : ""}</span></div>
        <div class="meta">${esc(b[k].items[b[k].items.length - 1].text.slice(0, 80))}…</div>
        <div class="actions">
          <button class="primary" data-action="kindle-flush" data-book="${esc(k)}">まとめて依頼</button>
          <button class="warn" data-action="kindle-drop" data-book="${esc(k)}">捨てる</button>
        </div></div>`
      )
      .join("");
}

async function loadLocalCaches() {
  cards = (await DB.get("cards")) || [];
  playlist = (await DB.get("playlist")) || [];
  renderTrainHome();
}

/** GitHubから最新を取得し、ローカルにも保存 */
async function syncAll() {
  await flushQueue();
  try {
    const c = await GH.getJSON(P.cards, []);
    cards = Array.isArray(c.data) ? c.data : [];
    await DB.set("cards", cards);
    setNet(true);
  } catch {
    setNet(false);
  }
  try {
    const pl = await GH.getJSON(P.playlist, []);
    playlist = Array.isArray(pl.data) ? pl.data : [];
    await DB.set("playlist", playlist);
  } catch {}
  await checkNewsBadge();
  renderTrainHome();
  refresh();
  updatePendingBadge();
}

function setNet(ok) {
  $("#net-dot").className = "dot " + (ok ? "ok" : "err");
}

async function updatePendingBadge() {
  const q = await DB.qAll();
  const badge = $("#pending-badge");
  const parts = [];
  if (q.length) parts.push(`未送信 ${q.length}`);
  if (pendingTaskCount) parts.push(`処理中 ${pendingTaskCount}`);
  badge.hidden = parts.length === 0;
  badge.textContent = parts.join(" / ");
  badge.dataset.action = "goto-explore";
  const due = cards.filter((c) => (c.srs?.due || "9999") <= today()).length;
  const tb = $("#train-badge");
  tb.hidden = !due;
  tb.textContent = due > 99 ? "99+" : due;
}

// ---------------------------------------------------------------- 送信キュー(オフライン対応)
/** 送信を試み、失敗したら必ず端末に退避する(データを絶対に失わない) */
async function queueOrRun(job) {
  try {
    await runJob(job);
    setNet(true);
    return true;
  } catch (e) {
    const offline = e instanceof GH.GHError && e.status === 0;
    await DB.qAdd({ ...job, attempts: 0, lastError: e.message });
    if (offline) setNet(false);
    updatePendingBadge();
    toast(
      offline
        ? "電波がないので端末に保存しました。つながり次第、自動送信します。"
        : "送信できませんでした(" + e.message + ")。端末に保存したので後で自動再送します。",
      5000
    );
    return false;
  }
}

async function runJob(job) {
  if (job.kind === "putFile") await GH.putFile(job.path, job.text, job.message);
  else if (job.kind === "cardsSync") await pushCards(job.answers);
}

const MAX_ATTEMPTS = 20;

async function flushQueue() {
  const items = (await DB.qAll()) || [];
  for (const it of items) {
    try {
      await runJob(it);
      await DB.qDel(it.id);
    } catch (e) {
      if (e instanceof GH.GHError && e.status === 0) return; // まだオフライン。順序を保つため中断
      const attempts = (it.attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await DB.qDel(it.id);
        toast("送信を諦めた項目があります: " + (it.path || it.kind), 6000);
      } else {
        await DB.qAdd({ ...it, id: undefined, attempts, lastError: e.message });
        await DB.qDel(it.id);
      }
      return; // 認証エラー等は他も失敗するので今回は打ち切り
    }
  }
  updatePendingBadge();
}

// ---------------------------------------------------------------- タスク(AI依頼)
const WORKER_PROMPT = `brain/WORKER.md に従って、brain/tasks/pending/ の未処理の依頼をすべて処理してください。

処理が終わったら、何をどこに保存したかを簡潔に報告してください。`;

/** 溜まった依頼をClaude Codeで実行させる(指示文をコピーしてClaudeを開く) */
async function runWorker() {
  try {
    await navigator.clipboard.writeText(WORKER_PROMPT);
    toast("指示文をコピーしました。Claudeアプリで貼り付けて送信してください。", 6000);
    setTimeout(() => window.open("https://claude.ai/code", "_blank", "noopener"), 500);
  } catch {
    $("#modal-title").textContent = "この文をClaudeに送ってください";
    $("#modal-body").innerHTML = `<p class="hint">ClaudeアプリのCodeタブでリポジトリ Thinking を選び、下の文を送ります。</p>
      <textarea rows="6" readonly>${esc(WORKER_PROMPT)}</textarea>`;
    $("#modal").hidden = false;
  }
}

async function createTask(type, title, payload) {
  const id = `${stamp()}_${type}`;
  const task = { id, type, title, payload, created: new Date().toISOString(), status: "pending" };
  const ok = await queueOrRun({
    kind: "putFile",
    path: `${P.pending}/${id}.json`,
    text: JSON.stringify(task, null, 1),
    message: `brain: 依頼 ${type} — ${title}`.slice(0, 70),
  });
  if (ok) {
    switchView("explore");
    toast("受け付けました。AIが自動で処理します。完了するとここに結果が出ます。", 6000);
  }
  refresh();
  return task;
}

async function listTasks() {
  const out = { pending: [], done: [] };
  try {
    out.pending = (await GH.listDir(P.pending)).filter((f) => f.name.endsWith(".json"));
    const done = (await GH.listDir(P.done)).filter((f) => f.name.endsWith(".json"));
    out.done = done.sort((a, b) => (a.name < b.name ? 1 : -1)).slice(0, 8);
    pendingTaskCount = out.pending.length;
    updatePendingBadge();
  } catch {}
  return out;
}

// ---------------------------------------------------------------- タブ
function switchView(v) {
  view = v;
  $$("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  $$(".view").forEach((el) => (el.hidden = el.id !== "view-" + v));
  refresh();
}
$$("#tabbar button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

async function refresh() {
  try {
    if (view === "news") await renderNews();
    else if (view === "capture") await renderCapture();
    else if (view === "train") renderTrainHome();
    else if (view === "learn") await renderLearn();
    else if (view === "think") await renderThink();
    else if (view === "explore") await renderExplore();
  } catch {}
}


// ---------------------------------------------------------------- 知る(ニュース)
let newsData = null;      // 表示中の日のデータ
let newsDay = null;       // null=latest.json、"YYYY-MM-DD"=その日
let newsDays = null;      // brain/news にある日付の一覧(降順)

const NEWS_SEEN_KEY = "brain.news.lastSeen";

async function loadNews(force) {
  if (newsData && !force) return newsData;
  const path = newsDay ? P.newsDir + "/" + newsDay + ".json" : P.newsLatest;
  const { data } = await GH.getJSON(path, null);
  newsData = data;
  if (data && data.date) {
    try { localStorage.setItem(NEWS_SEEN_KEY, data.date); } catch {}
    const b = $("#news-badge"); if (b) b.hidden = true;
  }
  return data;
}

/** まだ開いていない日のニュースがあればバッジを出す */
async function checkNewsBadge() {
  try {
    const { data } = await GH.getJSON(P.newsLatest, null);
    if (!data || !data.date) return;
    let seen = null;
    try { seen = localStorage.getItem(NEWS_SEEN_KEY); } catch {}
    const b = $("#news-badge");
    if (b) { b.textContent = "新"; b.hidden = seen === data.date; }
  } catch {}
}

async function renderNews() {
  const list = $("#news-list");
  const dateEl = $("#news-date");
  const report = $("#news-report");
  if (!newsData) list.innerHTML = '<div class="card"><div class="meta">読み込み中…</div></div>';

  let d;
  try {
    d = await loadNews(false);
  } catch (e) {
    list.innerHTML = '<div class="card"><div class="title">読み込めませんでした</div><div class="meta">' + esc(e.message) + "</div></div>";
    return;
  }

  if (!d || !Array.isArray(d.items)) {
    dateEl.textContent = "";
    list.innerHTML =
      '<div class="card"><div class="title">まだニュースがありません</div>' +
      '<div class="meta">毎朝5時に自動生成されます。初回はまだ動いていないか、生成に失敗しています。</div></div>';
    report.innerHTML = "";
    return;
  }

  dateEl.textContent = d.date || "";
  const items = d.items
    .map((it, i) => [it, i])
    .sort((a, b) => (NEWS_ORDER[a[0].kind] ?? 9) - (NEWS_ORDER[b[0].kind] ?? 9) || a[1] - b[1])
    .map((x) => x[0]);
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  list.innerHTML = items.length
    ? newsListHtml(items)
    : '<div class="card"><div class="meta">記事がありません。</div></div>';

  // 取得レポート(取れなかったものを隠さない)
  const fr = d.fetch_report || {};
  const warns = fr.warnings || [];
  const failed = fr.sources_failed || [];
  const nOk = (fr.sources_ok || []).length;
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  report.innerHTML =
    warns.length || failed.length
      ? '<details class="np-report"><summary>取得状況: ' + nOk + "件成功・" + failed.length +
        "件失敗</summary>" +
        warns.map((w) => '<div class="np-report-line">' + esc(w) + "</div>").join("") +
        failed.map((f) => '<div class="np-report-line">✕ ' + esc(f.id || "") + " — " + esc(f.reason || "") + "</div>").join("") +
        "</details>"
      : nOk
      ? '<div class="np-report-ok">取得状況: ' + nOk + "件すべて成功</div>"
      : "";
}

/** 面(セクション)の定義。新聞の紙面にあたる */
function newsSection(it) {
  if (it.kind === "serendipity") return { key: "ser", label: "偶然の一本", color: "var(--amber)" };
  if (it.author) return { key: "who", label: "ウォッチ", color: "var(--accent)" };
  if (it.theme === "golf") return { key: "golf", label: "ゴルフ", color: "var(--ok)" };
  if (it.theme === "entertainment") return { key: "ent", label: "エンタメ", color: "var(--cat-ent)" };
  return { key: "etc", label: "世界から", color: "var(--text-3)" };
}

const NEWS_SECTION_ORDER = ["who", "golf", "ent", "etc", "ser"];

/** 一覧は見出しのみ。本文はタップしてモーダルで読む */
function newsListHtml(items) {
  const groups = new Map();
  for (const it of items) {
    const sec = newsSection(it);
    if (!groups.has(sec.key)) groups.set(sec.key, { sec, list: [] });
    groups.get(sec.key).list.push(it);
  }
  return NEWS_SECTION_ORDER.filter((k) => groups.has(k))
    .map((k) => {
      const { sec, list } = groups.get(k);
      return (
        '<div class="np-sec" style="--np-c:' + sec.color + '">' +
        '<span class="np-sec-name">' + esc(sec.label) + "</span>" +
        '<span class="np-sec-n">' + list.length + "</span></div>" +
        list.map(newsRow).join("")
      );
    })
    .join("");
}

function newsRow(it) {
  const by = [it.author, it.source].filter(Boolean)[0] || "";
  const flag =
    it.confidence && it.confidence !== "high"
      ? '<span class="np-flag">' + (it.confidence === "low" ? "要検証" : "要確認") + "</span>"
      : "";
  return (
    '<article class="np" data-action="news-detail" data-id="' + esc(it.id || "") + '">' +
    '<h3 class="np-head">' + esc(it.title || "") + "</h3>" +
    '<div class="np-by">' + esc(by) + flag + "</div>" +
    "</article>"
  );
}

const NEWS_ORDER = { watch: 0, theme: 1, serendipity: 2 };

/** 記事の全文をモーダルで開く(新聞の本記にあたる) */
function newsDetail(id) {
  const it = newsItem(id);
  if (!it) return;
  const c = newsSection(it);
  const url = it.primary_url || it.url || "";
  const meta = [it.source, it.author, it.published].filter(Boolean).map(esc).join(" · ");
  const conf = { high: "確度 高", medium: "確度 中", low: "確度 低" }[it.confidence] || "";
  $("#modal-title").textContent = c.label;
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  $("#modal-body").innerHTML =
    '<h3 class="np-head np-head-full" style="--np-c:' + c.color + '">' + esc(it.title || "") + "</h3>" +
    '<div class="np-meta">' + meta + "</div>" +
    (it.summary || []).map((s) => '<div class="news-line">' + esc(s) + "</div>").join("") +
    (it.so_what ? '<div class="news-sowhat">' + esc(it.so_what) + "</div>" : "") +
    (it.bridge ? '<div class="news-bridge">↔ ' + esc(it.bridge) + "</div>" : "") +
    (it.injection_alert
      ? '<div class="news-alert">⚠️ 疑わしい埋め込み指示を検出: ' + esc(it.injection_alert) + "</div>"
      : "") +
    '<div class="news-why">' +
    (conf ? "<b>" + conf + "</b>" + (it.tier ? "・tier" + esc(String(it.tier)) : "") + " — " : "") +
    esc(it.confidence_reason || "") +
    ((it.also_reported_by || []).length
      ? "<br>他の報道: " + esc(it.also_reported_by.join("、"))
      : "") +
    "</div>" +
    '<div class="np-actions">' +
    (url
      ? '<a class="news-open" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">記事を開く</a>'
      : "") +
    '<button data-action="news-deep" data-id="' + esc(it.id || "") + '">深掘る</button>' +
    '<button class="warn" data-action="news-hide" data-id="' + esc(it.id || "") + '">興味なし</button>' +
    "</div>";
  $("#modal").hidden = false;
}

function newsItem(id) {
  return ((newsData && newsData.items) || []).find((x) => x.id === id);
}

async function newsFeedback(it, action) {
  await queueOrRun({
    kind: "putFile",
    path: P.newsFeedback + "/" + stamp() + "_" + action + ".json",
    text: JSON.stringify(
      {
        item_id: it.id,
        action,
        theme: it.theme || null,
        source: it.source || null,
        date: (newsData && newsData.date) || null,
        created: new Date().toISOString(),
      },
      null,
      1
    ),
    message: "brain-news: feedback " + action,
  });
}

async function newsOlder() {
  if (!newsDays) {
    try {
      const files = await GH.listDir(P.newsDir);
      newsDays = files
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f.name))
        .map((f) => f.name.slice(0, 10))
        .sort()
        .reverse();
    } catch {
      newsDays = [];
    }
  }
  if (!newsDays.length) return toast("過去のニュースがありません");
  const cur = newsDay || (newsData && newsData.date);
  const i = newsDays.indexOf(cur);
  const next = i < 0 ? newsDays[0] : newsDays[i + 1];
  if (!next) return toast("これ以上さかのぼれません");
  newsDay = next;
  newsData = null;
  renderNews();
}


// ---------------------------------------------------------------- 記録
async function doCapture(withAI) {
  const text = $("#capture-text").value.trim();
  if (!text) return toast("テキストを入力してください");
  if (captureKind === "kindle") {
    // ブラウザの Kindle ノートブック(read.amazon.co.jp/notebook)やアプリの共有文を貼り付けた場合。
    // 解析はワーカーに任せ、ここでは書名の確認だけ行う。
    showKindleConfirm({ format: "text", text, title: "", url: "", fileName: "", source: "paste" });
    return;
  }
  const name = `${stamp()}_${captureKind}.md`;
  const body =
    `---\ntype: inbox_raw\nkind: ${captureKind}\ncreated: ${new Date().toISOString()}\n` +
    `processed: false\nsource: mobile\n---\n\n${text}\n`;

  $("#capture-text").value = "";
  await queueOrRun({
    kind: "putFile",
    path: `${P.inbox}/${name}`,
    text: body,
    message: `brain: 記録 ${text.slice(0, 40)}`,
  });
  if (withAI) {
    await createTask("ingest", text.slice(0, 40), { raw_path: `${P.inbox}/${name}`, kind: captureKind, text });
  } else {
    toast("保存しました");
  }
  refresh();
}

async function renderCapture() {
  let files = [];
  try {
    files = (await GH.listDir(P.inbox)).filter((f) => f.name.endsWith(".md"));
  } catch {}
  files.sort((a, b) => (a.name < b.name ? 1 : -1));
  const q = await DB.qAll();
  let html = q
    .filter((j) => j.path && j.path.startsWith(P.inbox))
    .map((j) => `<div class="card"><span class="badge running">未送信</span>${esc(j.path.split("/").pop())}</div>`)
    .join("");
  html += files
    .slice(0, 12)
    .map(
      (f) => `<div class="card">
        <div class="title clickable" data-action="open-note" data-path="${esc(f.path)}">${esc(f.name.replace(/\.md$/, ""))}</div>
        <div class="actions">
          <button data-action="open-note" data-path="${esc(f.path)}">読む</button>
          <button class="warn" data-action="delete-file" data-path="${esc(f.path)}" data-label="${esc(f.name)}">削除</button>
        </div></div>`
    )
    .join("");
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  $("#capture-list").innerHTML = html || EMPTY("まだ記録はありません。");
  renderBasket();
}

// 依頼ファイル名(YYYY-MM-DD_HHMMSS_type.json)から経過分数と種類を取り出す
const TASK_LABEL = { ingest: "記録の判定", research: "リサーチ", connect: "点と点", lint: "週次Lint", learn: "音声生成", cards: "カード生成", kindle: "読書取り込み" };
// 実測ベースの目安(分)。これを超えたら詰まっている可能性を伝える
const TASK_ETA = { ingest: 5, research: 15, connect: 10, lint: 8, learn: 12, cards: 8, kindle: 12 };

function taskInfo(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})_(\w+)\.json$/);
  if (!m) return { kind: "", label: "", mins: null, eta: 12 };
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60000));
  const kind = m[7];
  return { kind, label: TASK_LABEL[kind] || kind, mins, eta: TASK_ETA[kind] || 12 };
}

// ---------------------------------------------------------------- 探る
async function renderExplore() {
  const t = await listTasks();
  let html = "";
  if (t.pending.length) {
    const infos = t.pending.map((f) => taskInfo(f.name));
    const oldest = infos.reduce((a, b) => (b.mins > a.mins ? b : a), infos[0]);
    const stuck = oldest.mins != null && oldest.mins > oldest.eta;
    html += `<div class="card run-banner">
      <div class="title"><span class="spinner"></span>${t.pending.length}件を自動処理中</div>
      <div class="meta">${
        stuck
          ? `${oldest.mins}分経過しています。目安(${oldest.eta}分)を超えました。まだ処理中の可能性もありますが、下のボタンで実行ログを確認できます。`
          : `依頼した直後から処理は始まっています。目安は${oldest.eta}分ほど。この画面を閉じても続きます。`
      }</div>
      <div class="actions"><button data-action="run-now">処理の状況を見る</button></div>
    </div>`;
  }
  html += t.pending
    .map((f) => {
      const i = taskInfo(f.name);
      const over = i.mins != null && i.mins > i.eta;
      return `<div class="card">
      <div><span class="badge ${over ? "amber" : "running"}"><span class="spinner"></span>処理中</span>${esc(i.label || f.name.replace(/\.json$/, ""))}</div>
      <div class="meta">${i.mins != null ? `${i.mins}分経過 / 目安${i.eta}分` : ""}</div>
      <div class="actions"><button class="warn" data-action="cancel-task" data-path="${esc(f.path)}" data-name="${esc(f.name)}">キャンセル</button></div>
    </div>`;
    })
    .join("");
  const dones = await Promise.all(
    t.done.slice(0, 6).map(async (f) => {
      let d = null;
      try { d = (await GH.getJSON(f.path, null)).data; } catch {}
      return { f, d };
    })
  );
  html += dones
    .map(({ f, d }) => {
      const err = d && d.status === "error";
      const r = (d && d.result) || {};
      const body = err
        ? `<div class="meta" style="color:var(--err)">${esc(d.error || "エラー")}</div>`
        : r.summary || r.message_for_user
        ? `<div class="meta">${esc(r.summary || r.message_for_user)}</div>`
        : "";
      const open = r.saved_path
        ? `<button data-action="open-note" data-path="${esc(r.saved_path)}">結果を見る</button>`
        : "";
      return `<div class="card">
      <div><span class="badge ${err ? "error" : "done"}">${err ? "エラー" : "完了"}</span>${esc((d && d.title) || f.name.replace(/\.json$/, ""))}</div>
      ${body}
      <div class="actions">${open}
        <button data-action="delete-file" data-path="${esc(f.path)}" data-label="この履歴">履歴を消す</button></div>
    </div>`;
    })
    .join("");
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  $("#explore-tasks").innerHTML = html || EMPTY("依頼はありません。");

  let notes = [];
  try {
    notes = (await GH.listDir(P.research)).filter((f) => f.name.endsWith(".md"));
  } catch {}
  notes.sort((a, b) => (a.name < b.name ? 1 : -1));
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  $("#research-notes").innerHTML =
    notes
      .slice(0, 10)
      .map((f) => {
        const title = f.name.replace(/\.md$/, "");
        return `<div class="card">
        <div class="title clickable" data-action="open-note" data-path="${esc(f.path)}">${esc(title)}</div>
        <div class="actions">
          <button data-action="open-note" data-path="${esc(f.path)}">読む</button>
          <button class="ok" data-action="note-to-audio" data-path="${esc(f.path)}" data-title="${esc(title)}">音声にする</button>
          <button class="warn" data-action="delete-file" data-path="${esc(f.path)}" data-label="${esc(title)}">削除</button>
        </div></div>`;
      })
      .join("") || EMPTY("まだリサーチノートはありません。");
}

// ---------------------------------------------------------------- 聴く
async function renderLearn() {
  const keys = (await DB.audioKeys()) || [];
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  $("#playlist").innerHTML =
    playlist
      .map((a) => {
        const has = keys.includes(a.file);
        return `<div class="card">
        <div class="title">${esc(a.title)}</div>
        <div class="meta">${fmtTime(a.created)} ・ 約${a.est_minutes}分${has ? " ・ 端末に保存済" : ""}</div>
        <div class="actions">
          ${has
            ? `<button class="ok" data-action="play" data-file="${esc(a.file)}" data-title="${esc(a.title)}">▶ 再生</button>
               <button data-action="audio-del" data-file="${esc(a.file)}">端末から消す</button>`
            : `<button class="ok" data-action="audio-dl" data-file="${esc(a.file)}" data-title="${esc(a.title)}">ダウンロード</button>`}
          <button class="warn" data-action="audio-delete-all" data-id="${esc(a.id)}" data-file="${esc(a.file)}" data-title="${esc(a.title)}">完全に削除</button>
        </div></div>`;
      })
      .join("") || EMPTY("まだ音声はありません。テーマから依頼してください。");
}

// ---- Vaultノートを選んで音声化 ----
let noteTree = null;

async function loadNoteTree() {
  const box = $("#note-list");
  box.innerHTML = `<div class="empty"><span class="spinner"></span>ノート一覧を読み込み中…</div>`;
  try {
    const tree = await GH.getTree();
    noteTree = tree
      .filter(
        (f) =>
          f.type === "blob" &&
          f.path.startsWith(P.vault + "/") &&
          f.path.endsWith(".md") &&
          !/\/(_inbox|00_assets|_archive|_stubs)\//.test(f.path) &&
          !/sync-conflict/.test(f.path)
      )
      .map((f) => ({ path: f.path, name: f.path.split("/").pop().replace(/\.md$/, ""), dir: f.path.split("/").slice(2, -1).join("/") }))
      .sort((a, b) => (a.path < b.path ? 1 : -1));
    await DB.set("noteTree", noteTree);
  } catch {
    noteTree = (await DB.get("noteTree")) || [];
    if (!noteTree.length) {
      // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
      box.innerHTML = EMPTY("一覧を取得できませんでした(オフラインの可能性)");
      return;
    }
  }
  renderNoteList("");
}

function renderNoteList(filter) {
  const q = filter.trim().toLowerCase();
  const hits = (noteTree || []).filter((n) => !q || n.name.toLowerCase().includes(q) || n.dir.toLowerCase().includes(q));
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  $("#note-list").innerHTML =
    hits
      .slice(0, 60)
      .map(
        (n) => `<label><input type="checkbox" value="${esc(n.path)}"><div>${esc(n.name)}<div class="np">${esc(n.dir)}</div></div></label>`
      )
      .join("") || EMPTY("該当するノートがありません");
}

async function downloadAudio(file, title) {
  toast("ダウンロード中…");
  try {
    const blob = await GH.getBlob(`${P.audioDir}/${file}`);
    await DB.audioSet(file, blob);
    toast(`「${title}」を端末に保存しました`);
    renderLearn();
  } catch (e) {
    toast("ダウンロード失敗: " + e.message);
  }
}

async function play(file, title) {
  const blob = await DB.audioGet(file);
  if (!blob) return toast("先にダウンロードしてください");
  const a = $("#player-audio");
  if (a._url) URL.revokeObjectURL(a._url);
  a._url = URL.createObjectURL(blob);
  a.src = a._url;
  a.playbackRate = speed;
  $("#player-title").textContent = title;
  $("#player").hidden = false;
  document.body.classList.add("has-player");
  a.play().catch(() => {});
  a.onplay = () => (a.playbackRate = speed);
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist: "Brain", album: "学習音声",
      artwork: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    navigator.mediaSession.setActionHandler("seekbackward", () => (a.currentTime = Math.max(0, a.currentTime - 10)));
    navigator.mediaSession.setActionHandler("seekforward", () => (a.currentTime += 15));
  }
}

// ---------------------------------------------------------------- 鍛える(ローカル完結)
function dueCards() {
  const t = today();
  return cards.filter((c) => (c.srs?.due || t) <= t);
}

function renderTrainHome() {
  if (session) return;
  const due = dueCards().length;
  const mature = cards.filter((c) => (c.srs?.interval || 0) >= 21).length;
  const el = $("#train-stats");
  if (el) {
    // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
    el.innerHTML = `
      <div class="stat"><div class="num accent">${due}</div><div class="lbl">今日の復習</div></div>
      <div class="stat"><div class="num">${mature}</div><div class="lbl">定着済</div></div>
      <div class="stat"><div class="num">${cards.length}</div><div class="lbl">カード計</div></div>`;
  }
  const btn = $("#btn-train-start");
  if (btn) btn.disabled = cards.length === 0;
  const info = $("#train-info");
  if (info) {
    // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
    info.innerHTML = cards.length
      ? ""
      : EMPTY("カードがまだありません。「＋ Vaultから追加を依頼」を押すと、Claudeがあなたのフレームからカードを作ります。");
  }
  updatePendingBadge();
}

function quizMode(card) {
  const modes = ["word_to_essence"];
  if (card.axes) modes.push("visual_to_word");
  if (card.case) modes.push("case_to_word");
  return modes[(card.srs?.reps || 0) % modes.length];
}

function startTrain() {
  const t = today();
  const due = cards.filter((c) => c.srs && c.srs.reps > 0 && c.srs.due <= t);
  const fresh = cards.filter((c) => !c.srs || (c.srs.reps === 0 && c.srs.lapses === 0));
  const shuffle = (a) => a.sort(() => Math.random() - 0.5);
  shuffle(due); shuffle(fresh);
  const picked = shuffle([...due.slice(0, 7), ...fresh.slice(0, 5)]);
  if (!picked.length) return toast("今日の分は完了しています");
  session = { cards: picked.map((c) => ({ ...c, mode: quizMode(c) })), idx: 0, revealed: false, answers: [], again: 0 };
  $("#train-home").hidden = true;
  $("#train-session").hidden = false;
  renderQuiz();
}

function scheduleLocal(srs, grade) {
  const d = new Date();
  if (grade === "again") {
    srs.lapses = (srs.lapses || 0) + 1;
    srs.interval = 0;
    srs.ease = Math.max(1.3, (srs.ease || 2.5) - 0.2);
  } else {
    srs.reps = (srs.reps || 0) + 1;
    if (grade === "easy") srs.ease = Math.min(3.0, (srs.ease || 2.5) + 0.15);
    let base;
    if (!srs.interval) base = grade === "good" ? 1 : 3;
    else base = Math.max(srs.interval + 1, Math.round(srs.interval * (srs.ease || 2.5) * (grade === "easy" ? 1.3 : 1)));
    srs.interval = Math.min(base, 365);
    d.setDate(d.getDate() + srs.interval);
  }
  srs.due = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return srs;
}

function axesSVG(axes, blank, word) {
  const W = 460, H = 400, cx = W / 2, cy = H / 2 + 10;
  const e = esc;
  let q = axes.quadrants || [];
  if (!Array.isArray(q)) q = [q["右上"] || "", q["左上"] || "", q["左下"] || "", q["右下"] || ""];
  q = [...q, "", "", "", ""].slice(0, 4);
  if (blank) q = ["?", "?", "?", "?"];
  const rects = [
    [cx, 55, W - 20 - cx, cy - 55, "#eef2ff"],
    [20, 55, cx - 20, cy - 55, "#f0fdf4"],
    [20, cy, cx - 20, H - 35 - cy, "#fefce8"],
    [cx, cy, W - 20 - cx, H - 35 - cy, "#fdf2f8"],
  ];
  const pos = [
    [cx + (W - cx) / 2, cy - (cy - 60) / 2],
    [cx / 2, cy - (cy - 60) / 2],
    [cx / 2, cy + (H - 30 - cy) / 2],
    [cx + (W - cx) / 2, cy + (H - 30 - cy) / 2],
  ];
  let s = `<svg viewBox="0 0 ${W} ${H}" class="q-img" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">
    <rect width="${W}" height="${H}" rx="14" fill="#fff" stroke="#e2e8f0"/>
    <text x="${cx}" y="34" text-anchor="middle" font-size="17" font-weight="700" fill="#1e293b">${e(blank ? "このパターンは?" : word)}</text>`;
  rects.forEach(([x, y, w, h, c]) => (s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`));
  s += `<line x1="20" y1="${cy}" x2="${W - 20}" y2="${cy}" stroke="#475569" stroke-width="1.6"/>
        <line x1="${cx}" y1="55" x2="${cx}" y2="${H - 35}" stroke="#475569" stroke-width="1.6"/>`;
  if (!blank) {
    s += `<text x="${W - 24}" y="${cy + 20}" text-anchor="end" font-size="12" font-weight="600" fill="#334155">${e(axes.x || "")} →</text>
          <text x="${cx + 8}" y="70" font-size="12" font-weight="600" fill="#334155">↑ ${e(axes.y || "")}</text>`;
  } else {
    s += `<text x="${W - 24}" y="${cy + 20}" text-anchor="end" font-size="12" fill="#cbd5e1">X軸?</text>
          <text x="${cx + 8}" y="70" font-size="12" fill="#cbd5e1">Y軸?</text>`;
  }
  q.forEach((label, i) => {
    const str = String(label || "");
    const fs = str.length <= 10 ? 14 : str.length <= 24 ? 12 : 10.5;
    const width = str.length <= 10 ? 9 : str.length <= 24 ? 11 : 13;
    const lines = (str.match(new RegExp(`.{1,${width}}`, "g")) || [""]).slice(0, 3);
    const lh = fs + 4;
    const y0 = pos[i][1] - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, k) => {
      s += `<text x="${pos[i][0]}" y="${(y0 + k * lh).toFixed(0)}" text-anchor="middle" font-size="${fs}" font-weight="700" fill="#0f172a">${e(ln)}</text>`;
    });
  });
  return s + "</svg>";
}

const MODE_LABEL = {
  word_to_essence: "このワードの中身を思い出す",
  visual_to_word: "このグラフのパターン名は?",
  case_to_word: "このケースに効くフレームは?",
};

function renderQuiz() {
  const c = session.cards[session.idx];
  let front;
  if (c.mode === "visual_to_word") {
    front = axesSVG(c.axes, true, c.word) + `<div class="q-sub">軸と象限から、パターン名と軸ラベルを思い出す</div>`;
  } else if (c.mode === "case_to_word") {
    front = `<div class="q-front" style="font-size:15px;font-weight:500">${esc(c.case)}</div>
             <div class="q-sub">→ どのフレームで斬る? 名前と適用の仕方まで想起</div>`;
  } else {
    front = `<div class="q-front">${esc(c.word)}</div>
             <div class="q-sub">本質・${c.axes ? "2軸・" : ""}発動条件を頭の中で言語化してから開く</div>`;
  }
  const back = session.revealed
    ? `<hr class="divider">
       <div class="q-front" style="font-size:16px">${esc(c.word)}</div>
       <div class="a-essence">${esc(c.essence)}</div>
       ${c.axes ? axesSVG(c.axes, false, c.word) : ""}
       ${c.hook ? `<div class="a-hook">🪝 ${esc(c.hook)}</div>` : ""}
       ${c.use_when ? `<div class="a-use">発動条件: ${esc(c.use_when)}</div>` : ""}
       ${c.note ? `<span class="note-link" data-action="open-note" data-path="${esc(P.vault + "/" + c.note)}">元ノートを見る →</span>` : ""}`
    : "";
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  $("#train-card").innerHTML = `<div class="q-type">${session.idx + 1} / ${session.cards.length} ・ ${MODE_LABEL[c.mode]}</div>${front}${back}`;
  $("#train-progress-bar").style.width = `${(session.idx / session.cards.length) * 100}%`;
  $("#train-count").textContent = `${session.cards.length - session.idx}枚`;
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  $("#train-actions").innerHTML = session.revealed
    ? `<button class="g-again" data-action="grade" data-g="again">もう一度<small>思い出せず</small></button>
       <button class="g-good" data-action="grade" data-g="good">できた<small>数秒かかった</small></button>
       <button class="g-easy" data-action="grade" data-g="easy">余裕<small>即答</small></button>`
    : `<button class="g-reveal" data-action="reveal">答えを見る</button>`;
}

function grade(g) {
  const c = session.cards[session.idx];
  session.answers.push({ id: c.id, grade: g });
  const local = cards.find((x) => x.id === c.id);
  if (local) {
    local.srs = scheduleLocal(local.srs || { reps: 0, ease: 2.5, interval: 0, lapses: 0 }, g);
    local.stats = local.stats || { seen: 0, correct: 0 };
    local.stats.seen++;
    if (g !== "again") local.stats.correct++;
  }
  if (g === "again") {
    session.again++;
    session.cards.push({ ...c });
  }
  session.idx++;
  session.revealed = false;
  if (session.idx >= session.cards.length) return finishTrain();
  renderQuiz();
}

async function finishTrain() {
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  $("#train-card").innerHTML = `<div class="done-card"><div class="big">🎉</div>
    <div class="q-front">今日の練習完了</div>
    <div class="q-sub">${session.answers.length}回想起 ・ つまずき${session.again}回<br>結果を保存しています…</div></div>`;
  $("#train-actions").innerHTML = `<button class="g-reveal" data-action="train-quit">ホームへ戻る</button>`;
  $("#train-progress-bar").style.width = "100%";
  await DB.set("cards", cards);          // まず端末に確定保存(以後は絶対に失われない)
  const answers = session.answers;
  const sent = await queueOrRun({ kind: "cardsSync", answers });
  const note = $("#train-card .q-sub");
  if (note) {
    // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
    note.innerHTML = `${answers.length}回想起 ・ つまずき${session.again}回<br>` +
      (sent ? "結果を保存しました。" : "結果は端末に保存済み。接続時に自動送信します。");
  }
}

/** GitHub上のcards.jsonへSRS結果を反映(競合に強いread-modify-write) */
async function pushCards(answers) {
  await GH.updateJSON(P.cards, [], (data) => {
    const list = Array.isArray(data) ? data : [];
    for (const a of answers) {
      const card = list.find((c) => c.id === a.id);
      if (!card) continue;
      card.srs = scheduleLocal(card.srs || { reps: 0, ease: 2.5, interval: 0, lapses: 0 }, a.grade);
      card.stats = card.stats || { seen: 0, correct: 0 };
      card.stats.seen++;
      if (a.grade !== "again") card.stats.correct++;
    }
    return list;
  }, `brain: 練習結果 ${answers.length}件`);
}

function quitTrain() {
  session = null;
  $("#train-session").hidden = true;
  $("#train-home").hidden = false;
  renderTrainHome();
  syncAll();
}

// ---------------------------------------------------------------- 対話(Claude Codeへ引き継ぎ)
const THINK_PROMPT = (topic) => `thinking-session スキルを使って、思考セッションを始めてください。

スキルの「手順0: 文脈をロードする」を必ず実行してから最初の問いを出してください。具体的には:
1. vault/メモ/00_索引/_AI_DIGEST.md(全ノートの地図)
2. vault/メモ/_memory/ の全ファイル(過去に確立した原則)
3. vault/メモ/05_セッション/ の直近3件(前回までの思考の続き)
これらを読まずに始めないでください。

今日考えたいテーマ:
${topic}

読み込みの報告は不要です。①観察した事象の解像度を上げる短い問い(3-6行)から始めてください。`;

async function renderThink() {
  let items = [];
  try {
    const months = (await GH.listDir(P.sessions)).filter((f) => f.type === "dir");
    months.sort((a, b) => (a.name < b.name ? 1 : -1));
    if (months[0]) items = (await GH.listDir(months[0].path)).filter((f) => f.name.endsWith(".md"));
  } catch {}
  items.sort((a, b) => (a.name < b.name ? 1 : -1));
  // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
  $("#think-list").innerHTML =
    items
      .slice(0, 10)
      .map(
        (f) => `<div class="card clickable" data-action="open-note" data-path="${esc(f.path)}">
        <div class="title">${esc(f.name.replace(/\.md$/, ""))}</div></div>`
      )
      .join("") || EMPTY("まだセッションはありません。");
}

// ---------------------------------------------------------------- ノート表示
function mdToHtml(md) {
  let fm = "";
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    fm = `<div class="fm">${esc(m[1]).replace(/\n/g, "<br>")}</div>`;
    md = md.slice(m[0].length);
  }
  let html = fm, inList = false, inCode = false;
  for (const line of md.split("\n")) {
    if (line.startsWith("```")) { inCode = !inCode; html += inCode ? "<pre><code>" : "</code></pre>"; continue; }
    if (inCode) { html += esc(line) + "\n"; continue; }
    let l = esc(line)
      .replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_, a, __, b) => `<span class="wikilink">${esc(b || a)}</span>`)
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    if (/^#{1,4} /.test(line)) {
      const lv = line.match(/^#+/)[0].length;
      html += `<h${lv}>${l.replace(/^#+\s*/, "")}</h${lv}>`;
    } else if (/^\s*[-*] /.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${l.replace(/^\s*[-*] /, "")}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += l ? `<p>${l}</p>` : "";
    }
  }
  if (inList) html += "</ul>";
  return html;
}

async function openNote(path) {
  try {
    toast("読み込み中…", 1200);
    const f = await GH.getFile(path);
    if (!f) return toast("ノートが見つかりません");
    $("#modal-title").textContent = path.split("/").pop().replace(/\.md$/, "");
    // eslint-disable-next-line no-unsanitized/property -- 組み立て済みの HTML。差し込む値は esc() 済みか数値・固定文字(2026-10-30 に全件確認)
    $("#modal-body").innerHTML = mdToHtml(f.text);
    $("#modal").hidden = false;
  } catch (e) {
    toast(e.message);
  }
}

// ---------------------------------------------------------------- イベント
document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;

  if (a === "setup-save") {
    const owner = $("#s-owner").value.trim();
    const repo = $("#s-repo").value.trim();
    const token = $("#s-token").value.trim();
    if (!owner || !repo || !token) return ($("#setup-msg").textContent = "3つとも入力してください");
    $("#setup-msg").textContent = "確認中…";
    el.disabled = true;
    try {
      const info = await GH.verify({ owner, repo, token, branch: "main" });
      if (!info.canWrite) throw new Error("このトークンには書き込み権限がありません(Contents: Read and write が必要)");
      GH.saveCfg({ owner, repo, token, branch: info.defaultBranch || "main" });
      $("#setup-msg").textContent = "接続できました: " + info.name;
      setTimeout(boot, 600);
    } catch (e) {
      $("#setup-msg").textContent = "✕ " + e.message;
    }
    el.disabled = false;
    return;
  }

  if (a === "settings") {
    const c = GH.loadCfg() || {};
    $("#modal-title").textContent = "設定";
    $("#modal-body").innerHTML = `<div class="cards">
      <div class="card"><div class="title">接続先</div><div class="meta">${esc(c.owner || "")}/${esc(c.repo || "")} (${esc(c.branch || "main")})</div></div>
      <div class="card clickable" data-action="force-sync"><div class="title">今すぐ同期</div><div class="meta">カード・プレイリスト・依頼状況を取り直す</div></div>
      <div class="card clickable" data-action="force-update"><div class="title">アプリを最新に更新</div><div class="meta">表示が崩れた時はこれ</div></div>
      <div class="card clickable" data-action="logout"><div class="title">接続をやり直す</div><div class="meta">トークンを入れ直す</div></div>
    </div>`;
    $("#modal").hidden = false;
    return;
  }
  if (a === "force-sync") { $("#modal").hidden = true; toast("同期中…"); await syncAll(); toast("同期しました"); return; }
  if (a === "force-update") {
    $("#modal").hidden = true;
    try {
      if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
      if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    } catch {}
    location.reload();
    return;
  }
  if (a === "logout") { if (confirm("接続情報を消して最初からやり直しますか?")) { GH.clearCfg(); location.reload(); } return; }

  if (a === "capture-ai") doCapture(true);
  else if (a === "capture-raw") doCapture(false);
  else if (a === "mic") toggleMic();

  else if (a === "kindle-send") {
    const data = window._sharedKindle;
    if (!data) return toast("共有データがありません");
    const book = ($("#kb-book").value || "").trim() || "書名不明";
    const author = ($("#kb-author").value || "").trim();
    $("#modal").hidden = true;
    window._sharedKindle = null;
    createTask("kindle", book.slice(0, 40), {
      book,
      author,
      asin: ((data.text || "").match(/asin=([A-Z0-9]{10})/i) || [])[1] || ((data.url || "").match(/\/dp\/([A-Z0-9]{10})/i) || [])[1] || "",
      text: data.text,
      format: data.format,
      fileName: data.fileName || "",
      source: "share",
    });
  }
  else if (a === "kindle-stash") {
    const data = window._sharedKindle;
    if (!data) return toast("共有データがありません");
    const book = ($("#kb-book").value || "").trim() || "書名不明";
    const author = ($("#kb-author").value || "").trim();
    $("#modal").hidden = true;
    window._sharedKindle = null;
    const n = await basketAdd(book, author, data.text);
    toast(`『${book}』に ${n} 件ためました。記録タブの「まとめて依頼」で送れます。`, 5000);
    $("#capture-text").value = "";
    renderBasket();
  }
  else if (a === "kindle-flush") basketFlush(el.dataset.book);
  else if (a === "kindle-drop") {
    const b = await basketGet();
    delete b[el.dataset.book];
    await DB.set("kindleBasket", b);
    renderBasket();
  }
  else if (a === "task-research") {
    const q = $("#research-q").value.trim();
    if (!q) return toast("問いを入力してください");
    $("#research-q").value = "";
    createTask("research", q.slice(0, 50), { question: q });
  }
  else if (a === "note-to-audio") {
    createTask("learn", "音声化: " + el.dataset.title.slice(0, 34), {
      paths: [el.dataset.path],
      topic: el.dataset.title,
      style: learnStyle,
      minutes: 10,
    });
  }
  else if (a === "learn-notes") {
    const paths = $$("#note-list input:checked").map((c) => c.value);
    if (!paths.length) return toast("ノートを選んでください");
    const first = paths[0].split("/").pop().replace(/\.md$/, "");
    $("#note-picker").open = false;
    $$("#note-list input:checked").forEach((c) => (c.checked = false));
    createTask("learn", "音声化: " + first.slice(0, 30) + (paths.length > 1 ? ` 他${paths.length - 1}件` : ""), {
      paths,
      style: learnStyle,
      minutes: parseInt($("#learn-minutes").value),
    });
  }
  else if (a === "news-detail") { newsDetail(el.dataset.id); }
  else if (a === "news-deep") {
    $("#modal").hidden = true;
    const it = newsItem(el.dataset.id);
    if (!it) return;
    const q =
      it.title + "(出典: " + (it.source || "") + " " + (it.primary_url || it.url || "") + ")。" +
      "この動きは何を意味するのか、背景・構造・反証を含めて調べてほしい。";
    await newsFeedback(it, "deep");
    createTask("research", (it.title || "").slice(0, 50), { question: q });
  }
  else if (a === "news-hide") {
    const it = newsItem(el.dataset.id);
    if (!it) return;
    $("#modal").hidden = true;
    await newsFeedback(it, "hide");
    newsData.items = newsData.items.filter((x) => x.id !== it.id);
    renderNews();
    toast("次回から出にくくなります");
  }
  else if (a === "news-older") newsOlder();
  else if (a === "news-reload") { newsDay = null; newsData = null; newsDays = null; renderNews(); }
  else if (a === "task-connect") createTask("connect", "点と点を結ぶ分析", { mode: "connect_dots" });
  else if (a === "task-lint") createTask("lint", "週次Lint", { mode: "weekly_lint" });
  else if (a === "task-cards") createTask("cards", "カード生成", { limit: 20 });
  else if (a === "task-learn") {
    const topic = $("#learn-topic").value.trim();
    if (!topic) return toast("テーマを入力してください");
    $("#learn-topic").value = "";
    createTask("learn", topic.slice(0, 40), { topic, style: learnStyle, minutes: parseInt($("#learn-minutes").value) });
  }

  else if (a === "train-start") startTrain();
  else if (a === "reveal") { session.revealed = true; renderQuiz(); }
  else if (a === "grade") grade(el.dataset.g);
  else if (a === "train-quit") quitTrain();

  else if (a === "run-worker") runWorker();
  else if (a === "run-now") {
    toast("実行ログを開きます。止まっている場合はここから手動で実行できます。", 5000);
    window.open("https://claude.ai/code/routines", "_blank", "noopener");
  }
  else if (a === "goto-explore") switchView("explore");

  else if (a === "cancel-task") {
    if (!confirm(`この依頼をキャンセルしますか?\n\n${el.dataset.name}`)) return;
    el.disabled = true;
    try {
      await GH.deleteFile(el.dataset.path, `brain: 依頼をキャンセル ${el.dataset.name}`);
      toast("キャンセルしました");
    } catch (e) {
      toast(e.status === 0 ? "電波がないためキャンセルできません" : "失敗: " + e.message);
    }
    el.disabled = false;
    refresh();
  }

  else if (a === "delete-file") {
    const label = el.dataset.label || el.dataset.path;
    if (!confirm(`削除しますか?\n\n${label}\n\n※GitHubの履歴には残るので、後から復元は可能です。`)) return;
    el.disabled = true;
    try {
      await GH.deleteFile(el.dataset.path, `brain: 削除 ${label}`);
      toast("削除しました");
    } catch (e) {
      toast(e.status === 0 ? "電波がないため削除できません" : "失敗: " + e.message);
    }
    el.disabled = false;
    refresh();
  }

  else if (a === "audio-delete-all") {
    const title = el.dataset.title;
    if (!confirm(`この音声を完全に削除しますか?\n\n${title}\n\n端末からもGitHubからも消えます。`)) return;
    el.disabled = true;
    try {
      await DB.audioDel(el.dataset.file);
      await GH.deleteFile(`${P.audioDir}/${el.dataset.file}`, `brain: 音声を削除 ${title}`).catch(() => {});
      playlist = await GH.updateJSON(
        P.playlist, [],
        (list) => (Array.isArray(list) ? list : []).filter((x) => x.id !== el.dataset.id),
        `brain: プレイリストから削除 ${title}`
      );
      await DB.set("playlist", playlist);
      toast("削除しました");
    } catch (e) {
      toast(e.status === 0 ? "電波がないため削除できません" : "失敗: " + e.message);
    }
    el.disabled = false;
    renderLearn();
  }

  else if (a === "audio-dl") downloadAudio(el.dataset.file, el.dataset.title);
  else if (a === "audio-del") { await DB.audioDel(el.dataset.file); renderLearn(); }
  else if (a === "play") play(el.dataset.file, el.dataset.title);
  else if (a === "player-close") {
    const p = $("#player-audio");
    p.pause();
    if (p._url) { URL.revokeObjectURL(p._url); p._url = null; }
    p.removeAttribute("src");
    $("#player").hidden = true;
    document.body.classList.remove("has-player");
  }

  else if (a === "think-open") {
    const topic = $("#think-topic").value.trim();
    if (!topic) return toast("テーマを入力してください");
    const text = THINK_PROMPT(topic);
    try {
      await navigator.clipboard.writeText(text);
      toast("指示文をコピーしました。Claudeアプリで貼り付けてください。", 5000);
    } catch {
      $("#modal-title").textContent = "この文をコピーしてClaudeへ";
      $("#modal-body").innerHTML = `<textarea rows="14" readonly>${esc(text)}</textarea>`;
      $("#modal").hidden = false;
      return;
    }
    setTimeout(() => window.open("https://claude.ai/code", "_blank", "noopener"), 400);
  }

  else if (a === "open-note") openNote(el.dataset.path);
  else if (a === "modal-close") $("#modal").hidden = true;
});

$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").hidden = true; });

$("#kind-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  captureKind = b.dataset.kind;
  $$("#kind-toggle button").forEach((x) => x.classList.toggle("active", x === b));
  const hint = $("#capture-hint");
  if (hint)
    hint.textContent =
      captureKind === "kindle"
        ? "Chrome で read.amazon.co.jp/notebook を開き、本を選んでページを全選択→コピーし、ここに貼り付けて「保存してAI判定を依頼」。Kindle アプリの「共有」で来た文を貼ってもよい。書名の確認画面が出ます。"
        : "文章はすぐGitHubの_inboxに保存されます(電波がなければ端末に貯めて後で自動送信)。分類はClaudeが後から行います。";
  if (captureKind === "kindle") $("#capture-text").placeholder = "Kindle ノートブックのコピー、または共有されたハイライトを貼り付け";
  else $("#capture-text").placeholder = "音声入力(キーボードのマイク)またはテキストで吹き込む";
});
$("#style-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  learnStyle = b.dataset.style;
  $$("#style-toggle button").forEach((x) => x.classList.toggle("active", x === b));
});
$("#note-picker").addEventListener("toggle", (e) => {
  if (e.target.open && !noteTree) loadNoteTree();
});
$("#note-search").addEventListener("input", (e) => {
  if (noteTree) renderNoteList(e.target.value);
});

$("#speed-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  speed = parseFloat(b.dataset.s);
  localStorage.setItem("brain_speed", String(speed));
  $$("#speed-toggle button").forEach((x) => x.classList.toggle("active", x === b));
  const p = $("#player-audio"); if (p) p.playbackRate = speed;
});

// ---------------------------------------------------------------- 音声入力
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
if (SR && window.isSecureContext) { const m = $("#btn-mic"); if (m) m.hidden = false; }
function toggleMic() {
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = "ja-JP"; rec.continuous = true; rec.interimResults = false;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++)
      if (e.results[i].isFinal) $("#capture-text").value += e.results[i][0].transcript;
  };
  rec.onend = () => { rec = null; $("#btn-mic").classList.remove("rec"); };
  rec.onerror = () => toast("音声認識エラー。キーボードのマイクをお使いください。");
  rec.start();
  $("#btn-mic").classList.add("rec");
}

// ---------------------------------------------------------------- ライフサイクル
window.addEventListener("online", () => { setNet(true); syncAll(); });
window.addEventListener("offline", () => setNet(false));
document.addEventListener("visibilitychange", () => { if (!document.hidden && !session) syncAll(); });

boot();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
