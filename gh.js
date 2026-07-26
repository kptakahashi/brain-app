/* gh.js — GitHubリポジトリを「サーバー」として使うデータ層
 *
 * サーバーを一切持たずに、スマホのブラウザから直接 GitHub の
 * プライベートリポジトリ(Vault)を読み書きする。
 * 認証は fine-grained Personal Access Token(端末のlocalStorageに保存)。
 */
"use strict";

const GH = (() => {
  const CFG_KEY = "brain_gh";
  const API = "https://api.github.com";

  let cfg = null;

  function loadCfg() {
    if (cfg) return cfg;
    try {
      cfg = JSON.parse(localStorage.getItem(CFG_KEY) || "null");
    } catch {
      cfg = null;
    }
    return cfg;
  }

  function saveCfg(next) {
    cfg = next;
    localStorage.setItem(CFG_KEY, JSON.stringify(next));
  }

  function clearCfg() {
    cfg = null;
    localStorage.removeItem(CFG_KEY);
  }

  function configured() {
    const c = loadCfg();
    return !!(c && c.owner && c.repo && c.token);
  }

  // ---------------------------------------------------------------- base64

  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function b64ToUtf8(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------------------------------------------------------------- 低レベル

  class GHError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  function headers(extra = {}) {
    const c = loadCfg();
    if (!c || !c.token) throw new GHError("GitHubの設定が未完了です", 0);
    return {
      Authorization: "Bearer " + c.token,
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
  }

  function contentsUrl(path) {
    const c = loadCfg();
    const enc = path.split("/").map(encodeURIComponent).join("/");
    return `${API}/repos/${c.owner}/${c.repo}/contents/${enc}`;
  }

  function branch() {
    const c = loadCfg();
    return (c && c.branch) || "main";
  }

  async function request(url, opts = {}) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new GHError("オフライン(GitHubに接続できません)", 0);
    }
    if (res.status === 401 || res.status === 403) {
      const body = await res.text();
      if (/rate limit/i.test(body)) throw new GHError("GitHubのレート上限。しばらく待ってください", 403);
      throw new GHError("トークンが無効か、権限が足りません", res.status);
    }
    return res;
  }

  // ---------------------------------------------------------------- 読み取り

  /** テキストファイルを読む → {text, sha} / 無ければ null */
  async function getFile(path) {
    const res = await request(
      contentsUrl(path) + "?ref=" + encodeURIComponent(branch()),
      { headers: headers({ Accept: "application/vnd.github+json" }), cache: "no-store" }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new GHError(`読み込み失敗 (${res.status}): ${path}`, res.status);
    const j = await res.json();
    if (Array.isArray(j)) throw new GHError("ディレクトリです: " + path, 400);
    return { text: j.content ? b64ToUtf8(j.content) : "", sha: j.sha, size: j.size };
  }

  /** JSONを読む。無ければ fallback を返す */
  async function getJSON(path, fallback = null) {
    const f = await getFile(path);
    if (!f) return { data: fallback, sha: null };
    try {
      return { data: JSON.parse(f.text), sha: f.sha };
    } catch {
      return { data: fallback, sha: f.sha };
    }
  }

  /** バイナリ(mp3など)を Blob で取得 */
  async function getBlob(path) {
    const res = await request(
      contentsUrl(path) + "?ref=" + encodeURIComponent(branch()),
      { headers: headers({ Accept: "application/vnd.github.raw" }) }
    );
    if (!res.ok) throw new GHError(`取得失敗 (${res.status}): ${path}`, res.status);
    return await res.blob();
  }

  /** リポジトリ全体のファイル一覧を1回の通信で取得 → [{path, type, size}] */
  async function getTree() {
    const c = loadCfg();
    const res = await request(
      `${API}/repos/${c.owner}/${c.repo}/git/trees/${encodeURIComponent(branch())}?recursive=1`,
      { headers: headers({ Accept: "application/vnd.github+json" }), cache: "no-store" }
    );
    if (!res.ok) throw new GHError(`一覧取得失敗 (${res.status})`, res.status);
    const j = await res.json();
    return Array.isArray(j.tree) ? j.tree : [];
  }

  /** ディレクトリ一覧 → [{name, path, size, type}] / 無ければ [] */
  async function listDir(path) {
    const res = await request(
      contentsUrl(path) + "?ref=" + encodeURIComponent(branch()),
      { headers: headers({ Accept: "application/vnd.github+json" }), cache: "no-store" }
    );
    if (res.status === 404) return [];
    if (!res.ok) throw new GHError(`一覧取得失敗 (${res.status}): ${path}`, res.status);
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  }

  // ---------------------------------------------------------------- 書き込み

  /** テキストを書く(新規/更新)。sha未指定なら自動取得 */
  async function putFile(path, text, message, sha = undefined) {
    if (sha === undefined) {
      const cur = await getFile(path);
      sha = cur ? cur.sha : undefined;
    }
    const body = {
      message: message || `brain: update ${path}`,
      content: utf8ToB64(text),
      branch: branch(),
    };
    if (sha) body.sha = sha;

    const res = await request(contentsUrl(path), {
      method: "PUT",
      headers: headers({ "Content-Type": "application/json", Accept: "application/vnd.github+json" }),
      body: JSON.stringify(body),
    });

    if (res.status === 409 || res.status === 422) {
      // 競合: 最新shaで1回だけ再試行
      const cur = await getFile(path);
      const retryBody = { ...body };
      if (cur) retryBody.sha = cur.sha;
      else delete retryBody.sha;
      const res2 = await request(contentsUrl(path), {
        method: "PUT",
        headers: headers({ "Content-Type": "application/json", Accept: "application/vnd.github+json" }),
        body: JSON.stringify(retryBody),
      });
      if (!res2.ok) throw new GHError(`書き込み失敗 (${res2.status}): ${path}`, res2.status);
      return await res2.json();
    }
    if (!res.ok) throw new GHError(`書き込み失敗 (${res.status}): ${path}`, res.status);
    return await res.json();
  }

  /** JSONを書く(read-modify-write。updater(data)が新データを返す) */
  async function updateJSON(path, fallback, updater, message) {
    const { data, sha } = await getJSON(path, fallback);
    const next = updater(structuredClone(data));
    await putFile(path, JSON.stringify(next, null, 1), message, sha || undefined);
    return next;
  }

  async function deleteFile(path, message) {
    const cur = await getFile(path);
    if (!cur) return false;
    const res = await request(contentsUrl(path), {
      method: "DELETE",
      headers: headers({ "Content-Type": "application/json", Accept: "application/vnd.github+json" }),
      body: JSON.stringify({ message: message || `brain: delete ${path}`, sha: cur.sha, branch: branch() }),
    });
    return res.ok;
  }

  // ---------------------------------------------------------------- 接続確認

  /** トークンとリポジトリの疎通確認 → {ok, name, private, permissions} */
  async function verify(candidate) {
    const prev = cfg;
    cfg = candidate;
    try {
      const res = await request(`${API}/repos/${candidate.owner}/${candidate.repo}`, {
        headers: headers({ Accept: "application/vnd.github+json" }),
        cache: "no-store",
      });
      if (!res.ok) throw new GHError(`リポジトリに接続できません (${res.status})`, res.status);
      const j = await res.json();
      return {
        ok: true,
        name: j.full_name,
        private: j.private,
        canWrite: !!(j.permissions && j.permissions.push),
        defaultBranch: j.default_branch,
      };
    } finally {
      cfg = prev;
    }
  }

  return {
    loadCfg, saveCfg, clearCfg, configured, verify,
    getFile, getJSON, getBlob, listDir, getTree,
    putFile, updateJSON, deleteFile,
    GHError,
  };
})();
