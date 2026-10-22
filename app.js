// 유튜브 댓글 도우미 (모바일 웹앱)
// 구조: 서버 없음. 구글 OAuth(리디렉션 방식)로 받은 1시간짜리 토큰으로
//       Sheets API(읽기/쓰기)와 YouTube Data API(게시)를 브라우저에서 직접 호출한다.
import * as L from "./lib.js?v=1.1.0";
import { CLIENT_ID, APP_VERSION, API_KEY } from "./config.js?v=1.1.0";

const $ = (id) => document.getElementById(id);
const REDIRECT_URI = location.origin + location.pathname.replace(/[^/]*$/, "");
const SCOPE_SHEETS = "https://www.googleapis.com/auth/spreadsheets";
const SCOPE_YT = "https://www.googleapis.com/auth/youtube.force-ssl";
const SCOPE_CHANNEL = `openid email ${SCOPE_YT} ${SCOPE_SHEETS}`;
const SCOPE_SHEET_ONLY = `openid email ${SCOPE_SHEETS}`;
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const YT = "https://www.googleapis.com/youtube/v3";
const RENEW_MARGIN_MS = 3 * 60 * 1000;   // 만료 3분 전이면 갱신
const DAILY_LIMIT = 200;                  // 10,000 단위 ÷ 댓글 50 단위

// ------------------------------------------------------------------ 저장소
const store = {
  get(key, def) {
    try { const v = localStorage.getItem("ytm." + key); return v == null ? def : JSON.parse(v); }
    catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem("ytm." + key, JSON.stringify(val)); } catch { /* 저장 불가 환경 */ }
  },
  del(key) { try { localStorage.removeItem("ytm." + key); } catch { /* 무시 */ } },
};

const logLines = [];
function log(...a) {
  const line = `[${L.kstStamp()}] ` + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  logLines.push(line.replace(/ya29\.[\w.-]+/g, "ya29.***"));   // 토큰은 절대 남기지 않음
  if (logLines.length > 300) logLines.shift();
  console.log(line);
}

// ------------------------------------------------------------------ 상태
const S = {
  channels: store.get("channels", {}),       // { channelId: {title, handle, thumb, email, token, exp} }
  current: store.get("current", null),
  sheetAuth: store.get("sheetAuth", null),   // { email, token, exp }
  sheets: store.get("sheets", []),           // [{ id, gid, title }]
  currentSheet: store.get("currentSheet", null),
  delay: store.get("delay", { lo: 30, hi: 90 }),
  usage: store.get("usage", {}),             // { "YYYY-MM-DD"(태평양 기준): n }
  filter: "pending",
  sheet: null,     // 불러온 시트 { id, title, tab, tabId, colCount, header, cols, pos, items, counts }
  running: false,
  stopReq: false,
  processed: [],   // 이번 실행에서 처리한 행 번호
  postingRow: null,
  wake: null,
  waitUntil: 0,
};

const persist = () => {
  store.set("channels", S.channels); store.set("current", S.current);
  store.set("sheetAuth", S.sheetAuth); store.set("sheets", S.sheets);
  store.set("currentSheet", S.currentSheet); store.set("delay", S.delay); store.set("usage", S.usage);
};

const now = () => Date.now();
const valid = (t) => t && t.token && t.exp - now() > 60 * 1000;
const channel = () => (S.current ? S.channels[S.current] : null);
const isRealEmail = (e) => !!e && !/pages\.plusgoogle\.com$/i.test(e);

// 시트용 토큰: 전용 시트 로그인이 있으면 그것, 없으면 (본계정 채널일 때) 채널 토큰
function sheetToken() {
  if (valid(S.sheetAuth)) return S.sheetAuth;
  const ch = channel();
  if (ch && isRealEmail(ch.email) && valid(ch)) return { token: ch.token, exp: ch.exp, email: ch.email };
  return null;
}

// ------------------------------------------------------------------ 화면 도우미
function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PLACEHOLDER_AVATAR = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#D0D4DA"/><circle cx="24" cy="19" r="8" fill="#fff"/><path d="M8 44c2-9 9-13 16-13s14 4 16 13" fill="#fff"/></svg>`);

function confirmDialog(title, html, okText = "게시 시작", { info = false } = {}) {
  return new Promise((resolve) => {
    const d = $("dlgConfirm");
    d.querySelector('button[value="cancel"]').classList.toggle("hidden", info);
    $("dlgTitle").textContent = title;
    $("dlgBody").innerHTML = html;
    $("dlgOk").textContent = okText;
    d.returnValue = "";
    d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true });
    d.showModal();
  });
}

// ------------------------------------------------------------------ OAuth (리디렉션 · implicit)
function randomHex(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function startLogin(kind, { silent = false, hint = "" } = {}) {
  const state = randomHex(16);
  store.set("oauth", { state, kind, silent, at: now() });
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "token",
    scope: kind === "sheet" ? SCOPE_SHEET_ONLY : SCOPE_CHANNEL,
    state,
    include_granted_scopes: "true",
    prompt: silent ? "none" : "select_account",
  });
  if (hint) p.set("login_hint", hint);
  log("로그인 이동", kind, silent ? "(자동 갱신)" : "");
  S.leaving = true;   // 페이지를 떠나는 중 — 실행 기록을 지우거나 '나가기' 경고를 띄우지 않음
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + p.toString());
}

/** 구글에서 돌아온 경우 주소 끝(#)의 토큰을 처리. 반환: { ok, kind, silent, error } 또는 null */
function readOAuthReturn() {
  if (!location.hash || location.hash.length < 2) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has("access_token") && !h.has("error")) return null;
  history.replaceState(null, "", location.pathname + location.search);   // 토큰을 주소창에서 즉시 제거
  const saved = store.get("oauth", null);
  store.del("oauth");
  if (!saved || saved.state !== h.get("state") || now() - saved.at > 15 * 60 * 1000) {
    return { ok: false, error: "로그인 확인값이 맞지 않습니다. 다시 로그인해주세요." };
  }
  if (h.has("error")) {
    const e = h.get("error");
    const map = {
      access_denied: "로그인이 거부되었습니다. 테스트 사용자로 등록된 계정인지 확인하세요.",
      interaction_required: "자동 로그인 갱신이 안 됐습니다. [다시 로그인]을 눌러주세요.",
      login_required: "자동 로그인 갱신이 안 됐습니다. [다시 로그인]을 눌러주세요.",
      consent_required: "권한 동의가 필요합니다. [다시 로그인]을 눌러주세요.",
    };
    return { ok: false, kind: saved.kind, silent: saved.silent, error: map[e] || `로그인 오류: ${e}` };
  }
  const granted = (h.get("scope") || "").split(" ");
  return {
    ok: true, kind: saved.kind, silent: saved.silent,
    token: h.get("access_token"),
    exp: now() + (Number(h.get("expires_in")) || 3600) * 1000,
    scopes: granted,
  };
}

async function finishLogin(r) {
  S.needLogin = null;
  if (r.kind === "sheet") {
    if (!r.scopes.includes(SCOPE_SHEETS)) throw new Error("시트 권한이 허용되지 않았습니다. 다시 로그인해서 모든 권한을 허용해주세요.");
    const email = await fetchEmail(r.token);
    S.sheetAuth = { token: r.token, exp: r.exp, email };
    persist();
    toast(`시트 계정: ${email || "로그인됨"}`);
    return;
  }
  if (!r.scopes.includes(SCOPE_YT)) throw new Error("유튜브 권한이 허용되지 않았습니다. 다시 로그인해서 모든 권한을 허용해주세요.");
  const email = await fetchEmail(r.token);
  const res = await api(`${YT}/channels?part=snippet&mine=true`, { token: r.token, exp: r.exp });
  const ch = res.items && res.items[0];
  if (!ch) throw new Error("선택한 계정에 유튜브 채널이 없습니다.");
  const sn = ch.snippet || {};
  const prev = S.current;
  S.channels[ch.id] = {
    title: sn.title || ch.id, handle: sn.customUrl || "",
    thumb: (sn.thumbnails && (sn.thumbnails.default || sn.thumbnails.medium || {}).url) || "",
    email, token: r.token, exp: r.exp,
  };
  S.current = ch.id;
  // 본계정 채널로 로그인했고 시트 권한이 있으면 시트 계정도 같이 채운다
  if (isRealEmail(email) && r.scopes.includes(SCOPE_SHEETS) && (!valid(S.sheetAuth) || S.sheetAuth.email === email)) {
    S.sheetAuth = { token: r.token, exp: r.exp, email };
  }
  persist();
  log("채널 로그인", sn.title, email ? "(" + email + ")" : "");
  if (prev && prev !== ch.id && r.silent) {
    // 자동 갱신했는데 다른 채널로 돌아옴 → 게시 이어가기 금지
    const run = store.get("run", null);
    if (run && run.channelId === prev) { store.del("run"); }
    toast("다른 채널로 로그인되어 게시를 멈췄습니다. 채널을 확인하세요.", 6000);
  } else if (!r.silent) {
    toast(`${sn.title} 채널로 로그인했습니다`);
  }
}

async function fetchEmail(token) {
  try {
    const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return "";
    return (await r.json()).email || "";
  } catch { return ""; }
}

// ------------------------------------------------------------------ API
class ApiError extends Error {
  constructor(status, body) {
    const why = L.errorReason(status, body);
    super(why.message);
    this.status = status; this.code = why.code; this.body = body;
  }
}

async function api(url, { method = "GET", body, token, exp } = {}) {
  if (!token || (exp && exp - now() < 30 * 1000)) throw new ApiError(401, "");
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error("네트워크 연결을 확인해주세요"); err.network = true; throw err;
  }
  const text = await res.text();
  if (!res.ok) { log("API 오류", res.status, url.split("?")[0], text.slice(0, 300)); throw new ApiError(res.status, text); }
  return text ? JSON.parse(text) : {};
}

const withSheet = (url, opts = {}) => {
  const t = sheetToken();
  if (!t) { const e = new ApiError(401, ""); e.sheet = true; throw e; }
  return api(url, { ...opts, token: t.token, exp: t.exp }).catch((e) => { if (e instanceof ApiError) e.sheet = true; throw e; });
};
const withChannel = (url, opts = {}) => {
  const c = channel();
  if (!c) throw new ApiError(401, "");
  return api(url, { ...opts, token: c.token, exp: c.exp });
};

// ------------------------------------------------------------------ 시트 읽기/쓰기
async function loadSheet() {
  const ref = S.sheets.find((s) => s.id === S.currentSheet);
  if (!ref) { S.sheet = null; render(); return; }
  setRunText("시트 불러오는 중…");
  const meta = await withSheet(`${SHEETS}/${ref.id}?fields=properties.title,sheets.properties(sheetId,title,index,gridProperties.columnCount)`);
  const tabs = (meta.sheets || []).map((s) => s.properties).sort((a, b) => a.index - b.index);
  const tab = (ref.gid != null && tabs.find((t) => t.sheetId === ref.gid)) || tabs[0];
  if (!tab) throw new Error("시트에 탭이 없습니다.");
  ref.title = meta.properties.title; persist();

  const rng = encodeURIComponent(`${L.quoteSheet(tab.title)}!A1:ZZ`);
  const data = await withSheet(`${SHEETS}/${ref.id}/values/${rng}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
  const values = data.values || [];
  const header = values[0] || [];
  const rows = values.slice(1);
  const cols = L.findColumns(header, rows);
  const plan = L.planManagedColumns(header, cols);
  S.sheet = {
    id: ref.id, title: ref.title, tab: tab.title, tabId: tab.sheetId,
    colCount: (tab.gridProperties && tab.gridProperties.columnCount) || 26,
    header, cols, pos: plan.pos, add: plan.add, items: [], counts: {}, error: "",
  };
  if (cols.comment < 0) S.sheet.error = "1행에 '댓글' 머리글이 없습니다. 맨 오른쪽 열 1행에 '댓글'이라고 적어주세요.";
  else if (cols.video < 0 && rows.length) S.sheet.error = "유튜브 주소가 들어 있는 열을 찾지 못했습니다.";
  else {
    const c = L.classifyRows(rows, cols, plan.pos);
    S.sheet.items = c.items; S.sheet.counts = c.counts;
  }
  log("시트 불러옴", ref.title, "/", tab.title, S.sheet.counts);
  setRunText(S.running ? $("runText").textContent : "준비됨");
  render();
}

/** 관리 열 머리글이 없으면 추가 (필요하면 시트 열 개수도 늘림) */
async function ensureManagedColumns() {
  const sh = S.sheet;
  if (!sh.add.length) return;
  const need = Math.max(...Object.values(sh.pos)) + 1;
  if (need > sh.colCount) {
    await withSheet(`${SHEETS}/${sh.id}:batchUpdate`, {
      method: "POST",
      body: { requests: [{ appendDimension: { sheetId: sh.tabId, dimension: "COLUMNS", length: need - sh.colCount } }] },
    });
    sh.colCount = need;
  }
  await withSheet(`${SHEETS}/${sh.id}/values:batchUpdate`, {
    method: "POST",
    body: {
      valueInputOption: "RAW",
      data: sh.add.map((a) => ({ range: `${L.quoteSheet(sh.tab)}!${L.colLetter(a.index)}1`, values: [[a.name]] })),
    },
  });
  log("관리 열 추가", sh.add.map((a) => a.name).join(", "));
  sh.add = [];
}

/** 한 행의 관리 열 값을 기록 (네트워크 오류면 2번 더 시도) */
async function writeRow(row, fields) {
  const sh = S.sheet;
  const data = Object.entries(fields).map(([name, v]) => ({
    range: `${L.quoteSheet(sh.tab)}!${L.colLetter(sh.pos[name])}${row}`, values: [[v]],
  }));
  for (let i = 0; i < 3; i++) {
    try {
      await withSheet(`${SHEETS}/${sh.id}/values:batchUpdate`, { method: "POST", body: { valueInputOption: "RAW", data } });
      const it = sh.items.find((x) => x.row === row);
      if (it) {
        if ("상태" in fields) it.status = fields["상태"];
        if ("댓글링크" in fields) it.link = fields["댓글링크"];
        if ("게시시각" in fields) it.postedAt = fields["게시시각"];
        if ("오류" in fields) it.error = fields["오류"];
        if ("게시채널" in fields) it.postedBy = fields["게시채널"];
        if ("공개확인" in fields) it.visibility = fields["공개확인"];
      }
      return;
    } catch (e) {
      if (!e.network || i === 2) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

// ------------------------------------------------------------------ 영상 확인 · 게시
async function videoInfo(ids) {
  const out = {};
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 50) {
    const res = await withChannel(`${YT}/videos?part=snippet,statistics&id=${uniq.slice(i, i + 50).join(",")}`);
    for (const v of res.items || []) {
      out[v.id] = { title: v.snippet.title, channel: v.snippet.channelTitle, commentsOn: "commentCount" in (v.statistics || {}) };
    }
  }
  return out;
}

async function postComment(vid, text) {
  const res = await withChannel(`${YT}/commentThreads?part=snippet`, {
    method: "POST",
    body: { snippet: { videoId: vid, topLevelComment: { snippet: { textOriginal: text } } } },
  });
  return res.id;
}

/** '게시 중'으로 남은 행: 내 채널 댓글이 실제로 달렸는지 확인 → 댓글 ID 또는 null */
async function findMyComment(vid, text) {
  const q = encodeURIComponent(text.replace(/\s+/g, " ").slice(0, 40));
  const res = await withChannel(`${YT}/commentThreads?part=snippet&videoId=${vid}&searchTerms=${q}&maxResults=50&order=time`);
  for (const t of res.items || []) {
    const sn = t.snippet.topLevelComment.snippet;
    if (sn.authorChannelId && sn.authorChannelId.value === S.current && (sn.textOriginal || "").trim() === text.trim()) return t.id;
  }
  return null;
}

// ------------------------------------------------------------------ 공개 확인
// 로그인하지 않은 사람(시크릿 창) 기준으로 댓글이 보이는지 확인한다.
// 로그인 토큰 없이 API 키로만 조회하면, 공개된 댓글만 돌아온다.
async function apiPublic(url) {
  let res;
  try { res = await fetch(url + (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(API_KEY)); }
  catch { const e = new Error("네트워크 연결을 확인해주세요"); e.network = true; throw e; }
  const text = await res.text();
  if (!res.ok) { log("공개 조회 오류", res.status, text.slice(0, 200)); throw new ApiError(res.status, text); }
  return text ? JSON.parse(text) : {};
}

async function checkVisibility({ manual = false } = {}) {
  const sh = S.sheet;
  if (!sh || sh.error || S.running || S.checkingVis || !sheetToken()) return;
  const due = sh.items.map((it) => ({ it, stage: L.visibilityStage(it) })).filter((x) => x.stage);
  if (!due.length) { if (manual) toast("지금 확인할 댓글이 없습니다 (게시 5분 후 1차, 24시간 후 2차)"); return; }
  S.checkingVis = true;
  try {
    await ensureManagedColumns();
    const visible = new Set();
    for (let i = 0; i < due.length; i += 50) {
      const ids = due.slice(i, i + 50).map((x) => L.commentIdFromLink(x.it.link));
      const res = await apiPublic(`${YT}/commentThreads?part=id&id=${ids.join(",")}&maxResults=50`);
      for (const t of res.items || []) visible.add(t.id);
    }
    let hidden = 0;
    for (const { it, stage } of due) {
      const ok = visible.has(L.commentIdFromLink(it.link));
      if (!ok) hidden++;
      const text = L.visibilityText(it.visibility, stage, ok);
      await writeRow(it.row, { "공개확인": text });
      it.visibility = text;
    }
    log("공개 확인", due.length, "건, 안 보임", hidden);
    if (hidden) toast(`⚠ 댓글 ${hidden}개가 다른 사람에게 안 보입니다 ('숨김' 탭 확인)`, 6000);
    else if (manual) toast(`${due.length}개 모두 공개 상태입니다`);
  } catch (e) {
    if (manual) toast(`공개 확인 실패: ${e.message}`, 5000);
    log("공개 확인 실패", e.message);
  } finally {
    S.checkingVis = false;
    render();
  }
}

// ------------------------------------------------------------------ 게시 실행
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayUsage = () => S.usage[L.quotaDayKey()] || 0;
function addUsage() {
  const k = L.quotaDayKey();
  S.usage = { [k]: (S.usage[k] || 0) + 1 };   // 오늘 것만 유지
  persist();
}

async function requestWake() {
  try { if ("wakeLock" in navigator && !S.wake) { S.wake = await navigator.wakeLock.request("screen"); S.wake.addEventListener("release", () => { S.wake = null; }); } }
  catch { /* 지원 안 함 · 거부됨 */ }
}
function releaseWake() { try { S.wake && S.wake.release(); } catch { /* 무시 */ } S.wake = null; }

/** 토큰이 곧 끝나면 실행 상태를 저장하고 자동 갱신(리디렉션). 페이지를 떠나면 true */
function renewIfNeeded() {
  const ch = channel(), st = sheetToken();
  const soon = (t) => !t || t.exp - now() < RENEW_MARGIN_MS;
  if (!soon(ch) && !soon(st)) return false;
  store.set("run", { channelId: S.current, sheetId: S.currentSheet, at: now() });
  if (soon(ch)) startLogin("channel", { silent: true, hint: isRealEmail(ch && ch.email) ? ch.email : "" });
  else startLogin("sheet", { silent: true, hint: (S.sheetAuth && S.sheetAuth.email) || "" });
  return true;
}

async function startRun({ resumed = false } = {}) {
  if (S.running) return;
  const ch = channel();
  if (!ch || !valid(ch)) { toast("먼저 로그인해주세요"); return; }
  if (!S.sheet || S.sheet.error) { toast("시트를 먼저 불러와주세요"); return; }

  // 1) 게시 중으로 남은 행 정리
  const orphans = S.sheet.items.filter((i) => i.kind === "orphan");
  if (orphans.length) {
    setRunText(`지난번에 끊긴 ${orphans.length}건 확인 중…`);
    for (const it of orphans) {
      try {
        const id = await findMyComment(it.vid, it.text);
        if (id) {
          await writeRow(it.row, { "상태": L.STATUS.DONE, "댓글링크": `${L.videoUrl(it.vid)}&lc=${id}`, "게시채널": ch.title, "오류": "" });
          it.kind = "done";
        } else { it.kind = "target"; }
      } catch (e) { log("끊긴 행 확인 실패", it.row, e.message); it.kind = "target"; }
    }
  }

  let queue = S.sheet.items.filter((i) => i.kind === "target" || i.kind === "fail");
  if (!queue.length) { render(); toast("게시할 행이 없습니다"); return; }

  // 2) 영상 사전 확인
  setRunText("영상 확인 중…");
  let info;
  try { info = await videoInfo(queue.map((i) => i.vid)); }
  catch (e) { return handleRunError(e); }
  await ensureManagedColumns().catch((e) => { throw e; });
  const skipped = [];
  for (const it of queue) {
    const v = info[it.vid];
    if (v) { it.title = it.title || v.title; it.channel = it.channel || v.channel; }
    if (!v || !v.commentsOn) {
      const why = !v ? "영상이 없거나 비공개" : "댓글이 꺼진 영상";
      skipped.push(it);
      await writeRow(it.row, { "상태": L.STATUS.SKIP, "오류": why }).catch(() => {});
      it.kind = "skip"; it.status = L.STATUS.SKIP; it.error = why;
    }
  }
  queue = queue.filter((i) => i.kind !== "skip");
  render();
  if (!queue.length) { toast("게시할 수 있는 영상이 없습니다"); return; }

  // 3) 확인 창 (자동 이어가기일 땐 생략)
  const left = Math.max(0, DAILY_LIMIT - todayUsage());
  if (!resumed) {
    const mins = Math.max(1, Math.round(((queue.length - 1) * (S.delay.lo + S.delay.hi)) / 2 / 60));
    const reps = L.repeatedTexts(queue);
    let html = `<div><b>${esc(ch.title)}</b> 채널로 댓글 <b>${queue.length}개</b>를 게시합니다.</div>
      <div class="muted small">시트: ${esc(S.sheet.title)} · 예상 약 ${mins}분 (간격 ${S.delay.lo}~${S.delay.hi}초)</div>
      <div class="muted small">끝날 때까지 이 화면을 켜두세요.</div>`;
    if (skipped.length) html += `<div class="muted small">댓글 꺼짐·없는 영상 ${skipped.length}개는 '건너뜀'으로 표시했습니다.</div>`;
    if (queue.length > left) html += `<div class="warnline">오늘 남은 한도(약 ${left}개, 이 기기 기준)보다 많습니다. 한도에 닿으면 자동으로 멈춥니다.</div>`;
    if (reps.length) html += `<div class="warnline">같은 댓글이 여러 영상에 반복됩니다 (${reps.slice(0, 2).map((t) => "“" + esc(t.slice(0, 15)) + "”").join(", ")}). 스팸으로 걸러질 수 있습니다.</div>`;
    if (!(await confirmDialog("게시할까요?", html))) { setRunText("취소했습니다"); return; }
  }

  // 4) 실행
  S.running = true; S.stopReq = false; S.processed = [];
  store.set("run", { channelId: S.current, sheetId: S.currentSheet, at: now() });
  await requestWake();
  render();
  let ok = 0, fail = 0, stopReason = "";
  const total = queue.length;
  try {
    for (let i = 0; i < queue.length; i++) {
      if (S.stopReq) break;
      if (renewIfNeeded()) return;           // 로그인 갱신하러 이동 → 돌아오면 자동으로 이어감
      const it = queue[i];
      S.postingRow = it.row;
      setProgress(i, total, `${i + 1}/${total} 게시 중…`);
      render();
      await writeRow(it.row, { "상태": L.STATUS.POSTING, "오류": "" });
      try {
        const id = await postComment(it.vid, it.text);
        addUsage();
        const fields = { "상태": L.STATUS.DONE, "게시시각": L.kstStamp(), "댓글링크": `${L.videoUrl(it.vid)}&lc=${id}`, "게시채널": ch.title, "오류": "" };
        try { await writeRow(it.row, fields); }
        catch (e) {
          // 게시는 됐는데 시트 기록 실패 → 중복 방지를 위해 여기서 멈춤
          stopReason = `게시는 됐지만 시트 기록에 실패했습니다 (${it.row}행). 시트를 확인해주세요.`;
          log("기록 실패", it.row, e.message);
          it.kind = "done"; S.processed.push(it.row); ok++;
          break;
        }
        it.kind = "done"; ok++;
      } catch (e) {
        if (e.network) {   // 게시됐는지 알 수 없음 → '게시 중'으로 두고 멈춤 (다음 실행 때 확인)
          stopReason = "네트워크가 끊겼습니다. 다시 시작하면 해당 행이 실제로 게시됐는지 먼저 확인합니다.";
          break;
        }
        if (e.code === "auth" || e.code === "scope") {
          await writeRow(it.row, { "상태": "", "오류": "" }).catch(() => {});
          stopReason = "로그인이 만료되었습니다. [다시 로그인] 후 이어서 게시하세요.";
          break;
        }
        const st = e.code === "disabled" || e.code === "notfound" ? L.STATUS.SKIP : L.STATUS.FAIL;
        await writeRow(it.row, { "상태": st, "오류": e.message }).catch(() => {});
        it.kind = st === L.STATUS.SKIP ? "skip" : "fail"; it.error = e.message; fail++;
        if (e.code === "quota") { stopReason = e.message; S.processed.push(it.row); break; }
        if (e.code === "forbidden") { stopReason = e.message; S.processed.push(it.row); break; }
      }
      S.processed.push(it.row);
      S.postingRow = null;
      setProgress(i + 1, total, `${i + 1}/${total} 완료`);
      render();
      if (i < queue.length - 1 && !S.stopReq) {
        const ms = L.randomDelay(S.delay.lo, S.delay.hi) * 1000;
        S.waitUntil = now() + ms;
        while (!S.stopReq && now() < S.waitUntil) {
          setRunText(`${i + 1}/${total} 완료 · 다음 게시까지 ${Math.ceil((S.waitUntil - now()) / 1000)}초`);
          await sleep(500);
        }
      }
    }
  } catch (e) {
    stopReason = e instanceof ApiError && e.sheet ? `시트 기록 오류: ${e.message}` : e.message;
    log("실행 오류", e.message);
  } finally {
    S.running = false; S.postingRow = null; S.waitUntil = 0;
    if (!S.leaving) store.del("run");
    releaseWake();
  }
  if (S.leaving) return;
  const stopped = S.stopReq;
  setProgress(ok + fail, total, `완료 ${ok} · 실패 ${fail}${stopped ? " · 중지됨" : ""}`);
  if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate([120, 80, 120]);
  let html = `<div>게시 완료 <b>${ok}</b>개 · 실패 <b>${fail}</b>개</div>`;
  if (stopReason) html += `<div class="warnline">${esc(stopReason)}</div>`;
  else if (stopped) html += `<div class="muted small">중지했습니다. 다시 시작하면 남은 행만 이어서 게시합니다.</div>`;
  html += `<div class="muted small">'게시 완료'는 유튜브가 받아들였다는 뜻입니다. 다른 사람에게 보이는지는 시크릿 창에서 확인하세요.</div>`;
  render();
  await confirmDialog("결과", html, "확인", { info: true });
  loadSheet().catch(() => {});
}

function handleRunError(e) {
  S.running = false;
  if (e instanceof ApiError && e.code === "auth") { showAuthBanner(e.sheet ? "sheet" : "channel"); return; }
  toast(e.message, 5000);
  setRunText(e.message);
  render();
}

// ------------------------------------------------------------------ 렌더링
function setRunText(t) { $("runText").textContent = t; }
function setProgress(done, total, text) {
  $("progBar").style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
  setRunText(text);
}

function showAuthBanner(kind) {
  S.needLogin = kind;
  const b = $("authBanner");
  const isSheet = kind === "sheet";
  b.innerHTML = `${isSheet ? "시트를 읽으려면 시트 권한이 있는 구글 계정 로그인이 필요합니다." : "로그인이 만료되었습니다."}
    <div><button class="primary small" id="btnRelogin">${isSheet ? "시트 계정 로그인" : "다시 로그인"}</button></div>`;
  b.classList.remove("hidden");
  $("btnRelogin").onclick = () => startLogin(isSheet ? "sheet" : "channel", { hint: isSheet ? "" : (channel() && isRealEmail(channel().email) ? channel().email : "") });
}

function renderAccount() {
  const ch = channel();
  $("acctAvatar").src = (ch && ch.thumb) || PLACEHOLDER_AVATAR;
  $("acctTitle").textContent = ch ? ch.title : "로그인이 필요합니다";
  if (ch) {
    const who = isRealEmail(ch.email) ? ch.email : "브랜드 채널";
    const state = valid(ch) ? `${Math.max(1, Math.round((ch.exp - now()) / 60000))}분 남음` : "로그인 만료";
    $("acctSub").textContent = `${ch.handle ? ch.handle + " · " : ""}${who} · ${state}`;
  } else {
    $("acctSub").textContent = "구글 계정 선택 → 게시할 채널 선택";
  }
  const sel = $("selChannel");
  const ids = Object.keys(S.channels);
  sel.innerHTML = ids.length
    ? ids.map((id) => `<option value="${esc(id)}" ${id === S.current ? "selected" : ""}>${esc(S.channels[id].title)}</option>`).join("")
      + `<option value="__add">＋ 다른 채널 추가…</option><option value="__remove">이 채널 목록에서 빼기</option>`
    : `<option>채널 없음</option>`;
  sel.disabled = !ids.length || S.running;
  const btn = $("btnLogin");
  btn.textContent = !ch ? "구글 로그인" : valid(ch) ? "다시 로그인" : "로그인 갱신";
  btn.classList.toggle("primary", !ch || !valid(ch));
  btn.disabled = S.running;

  const sa = $("sheetAuth");
  const st = sheetToken();
  if (st) sa.innerHTML = `시트 계정: ${esc(st.email || "로그인됨")}`;
  else if (ch) sa.innerHTML = `시트 계정: 없음 <button class="small" id="btnSheetLogin">시트 계정 로그인</button>`;
  else sa.innerHTML = "";
  const b2 = $("btnSheetLogin");
  if (b2) b2.onclick = () => startLogin("sheet");
  if (!S.needLogin) $("authBanner").classList.add("hidden");
}

function renderSheets() {
  const sel = $("selSheet");
  sel.innerHTML = S.sheets.length
    ? S.sheets.map((s) => `<option value="${esc(s.id)}" ${s.id === S.currentSheet ? "selected" : ""}>${esc(s.title || s.id.slice(0, 12) + "…")}</option>`).join("")
    : `<option>등록된 시트 없음</option>`;
  sel.disabled = !S.sheets.length || S.running;
  $("btnAddSheet").disabled = S.running;
  $("btnRefresh").disabled = !S.currentSheet || S.running;
  $("btnVis").disabled = !S.sheet || !!S.sheet.error || S.running || S.checkingVis;
  const lnk = $("lnkSheet");
  if (S.currentSheet) { lnk.hidden = false; lnk.href = `https://docs.google.com/spreadsheets/d/${S.currentSheet}/edit`; }
  else lnk.hidden = true;

  const sh = S.sheet;
  const w = $("sheetWarn");
  const sum = $("summary");
  if (!sh) { sum.innerHTML = ""; w.classList.add("hidden"); return; }
  if (sh.error) { w.textContent = sh.error; w.classList.remove("hidden"); sum.innerHTML = ""; return; }
  const c = sh.counts;
  const chip = (label, n) => (n ? `<span class="chip">${label} <b>${n}</b></span>` : "");
  sum.innerHTML = `<span class="chip">📄 ${esc(sh.tab)}</span>` + chip("대기", c.target + c.fail + c.orphan) + chip("완료", c.done)
    + chip("건너뜀", c.skip + c.dup) + chip("주소 오류", c.invalid) + chip("댓글 없음", c.empty)
    + chip("👁 보임", sh.items.filter((i) => L.visibilityState(i.visibility) === "visible").length)
    + chip("🚫 안 보임", sh.items.filter((i) => L.visibilityState(i.visibility) === "hidden").length);
  const reps = L.repeatedTexts(sh.items);
  if (reps.length) {
    w.textContent = `같은 댓글이 여러 영상에 반복됩니다 (“${reps[0].slice(0, 20)}”${reps.length > 1 ? ` 외 ${reps.length - 1}개` : ""}). 스팸으로 걸러질 가능성이 높습니다.`;
    w.classList.remove("hidden");
  } else w.classList.add("hidden");
}

const KIND_BADGE = {
  target: ["대기", ""], fail: ["재시도", "fail"], orphan: ["확인 필요", "fail"], done: ["✓ 완료", "ok"],
  skip: ["건너뜀", ""], dup: ["중복", ""], invalid: ["주소 오류", "fail"], empty: ["댓글 없음", ""],
};

function renderList() {
  const sh = S.sheet;
  const list = $("list");
  const empty = $("emptyMsg");
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.filter === S.filter));
  if (!sh || sh.error) { list.innerHTML = ""; empty.classList.remove("hidden"); empty.textContent = sh ? "" : "시트를 등록하면 댓글이 있는 행이 여기에 표시됩니다."; return; }
  let items = sh.items.filter((i) => i.kind !== "empty");
  if (S.filter === "pending") items = items.filter((i) => ["target", "fail", "orphan"].includes(i.kind) || i.row === S.postingRow);
  if (S.filter === "done") items = items.filter((i) => S.processed.includes(i.row) || i.row === S.postingRow);
  if (S.filter === "hidden") items = items.filter((i) => L.visibilityState(i.visibility) === "hidden");
  empty.classList.toggle("hidden", items.length > 0);
  empty.textContent = S.filter === "pending" ? "게시할 행이 없습니다. 시트의 '댓글' 칸을 채우고 새로고침하세요."
    : S.filter === "hidden" ? "안 보이는 댓글이 없습니다. (게시 5분 뒤 1차, 24시간 뒤 2차 자동 확인)" : "아직 없습니다.";
  list.innerHTML = items.slice(0, 300).map((it) => {
    const posting = it.row === S.postingRow;
    const [label, cls] = posting ? ["게시 중", "run"] : KIND_BADGE[it.kind] || [it.kind, ""];
    const title = it.title || it.url;
    const link = it.link ? ` · <a href="${esc(it.link)}" target="_blank" rel="noopener">댓글 보기</a>` : "";
    const err = it.error && it.kind !== "done" ? ` · ${esc(it.error)}` : "";
    const vs = L.visibilityState(it.visibility);
    const vis = it.kind === "done" ? (vs === "hidden" ? ` · <b class="hid">🚫 ${esc(it.visibility.split("→").pop().trim())}</b>`
      : vs === "visible" ? ` · 👁 ${esc(it.visibility.split("→").pop().trim())}` : (it.link ? " · 공개 확인 대기" : "")) : "";
    return `<li class="item ${posting ? "posting" : ""}">
      <div class="top"><div class="title">${esc(title)}</div><span class="badge ${cls}">${label}</span></div>
      <div class="meta">${it.row}행${it.channel ? " · " + esc(it.channel) : ""}${it.vid ? ` · <a href="${L.videoUrl(it.vid)}" target="_blank" rel="noopener">영상</a>` : ""}${link}${err}${vis}</div>
      <div class="comment">${esc(it.text)}</div>
    </li>`;
  }).join("");
}

function renderRunbar() {
  const can = !!(channel() && valid(channel()) && S.sheet && !S.sheet.error &&
    S.sheet.items.some((i) => ["target", "fail", "orphan"].includes(i.kind)));
  $("btnStart").classList.toggle("hidden", S.running);
  $("btnStop").classList.toggle("hidden", !S.running);
  $("btnStart").disabled = !can;
  $("btnStop").disabled = S.stopReq;
}

function render() { renderAccount(); renderSheets(); renderList(); renderRunbar(); }

// ------------------------------------------------------------------ 이벤트
function bind() {
  $("btnLogin").onclick = () => startLogin("channel");
  $("selChannel").onchange = (e) => {
    const v = e.target.value;
    if (v === "__add") { startLogin("channel"); return; }
    if (v === "__remove") {
      const ch = channel();
      if (ch && window.confirm(`'${ch.title}' 채널을 목록에서 뺄까요? (유튜브에는 영향 없음)`)) {
        delete S.channels[S.current];
        S.current = Object.keys(S.channels)[0] || null;
        persist();
      }
      render(); return;
    }
    S.current = v; persist(); render();
  };
  $("btnAddSheet").onclick = () => { $("formAddSheet").classList.toggle("hidden"); $("inpSheet").focus(); };
  $("btnCancelSheet").onclick = () => $("formAddSheet").classList.add("hidden");
  $("btnRemoveSheet").onclick = () => {
    const ref = S.sheets.find((s) => s.id === S.currentSheet);
    if (!ref || !window.confirm(`'${ref.title || "이 시트"}'를 목록에서 뺄까요? (시트 자체는 그대로)`)) return;
    S.sheets = S.sheets.filter((s) => s.id !== ref.id);
    S.currentSheet = S.sheets[0] ? S.sheets[0].id : null; S.sheet = null;
    persist(); $("formAddSheet").classList.add("hidden"); render(); safeLoad();
  };
  $("formAddSheet").onsubmit = (e) => {
    e.preventDefault();
    const p = L.parseSheetUrl($("inpSheet").value);
    if (!p) { toast("구글 시트 링크가 아닙니다"); return; }
    const existing = S.sheets.find((s) => s.id === p.id);
    if (existing) existing.gid = p.gid; else S.sheets.unshift({ id: p.id, gid: p.gid, title: "" });
    S.currentSheet = p.id; persist();
    $("inpSheet").value = ""; $("formAddSheet").classList.add("hidden");
    safeLoad();
  };
  $("selSheet").onchange = (e) => { S.currentSheet = e.target.value; S.sheet = null; persist(); render(); safeLoad(); };
  $("btnRefresh").onclick = () => safeLoad();
  $("btnVis").onclick = () => checkVisibility({ manual: true });
  document.querySelectorAll(".tab").forEach((t) => t.onclick = () => { S.filter = t.dataset.filter; renderList(); });
  $("btnStart").onclick = () => startRun().catch(handleRunError);
  $("btnStop").onclick = () => { S.stopReq = true; S.waitUntil = 0; setRunText("현재 행까지만 처리하고 멈춥니다…"); renderRunbar(); };

  $("btnSettings").onclick = () => {
    $("inpLo").value = S.delay.lo; $("inpHi").value = S.delay.hi;
    $("usageText").textContent = `오늘 이 기기에서 게시: ${todayUsage()}개 · 하루 한도 약 ${DAILY_LIMIT}개 (오후 4~5시경 초기화)`;
    $("verText").textContent = `버전 ${APP_VERSION}`;
    $("dlgSettings").showModal();
  };
  $("btnSettingsSave").onclick = () => {
    const lo = Math.max(0, Math.min(3600, parseInt($("inpLo").value, 10) || 0));
    const hi = Math.max(0, Math.min(3600, parseInt($("inpHi").value, 10) || 0));
    S.delay = { lo: Math.min(lo, hi), hi: Math.max(lo, hi) }; persist();
  };
  $("btnCopyLog").onclick = async () => {
    const text = [`버전 ${APP_VERSION}`, navigator.userAgent, ...logLines].join("\n");
    try { await navigator.clipboard.writeText(text); toast("기록을 복사했습니다"); }
    catch { toast("복사하지 못했습니다"); }
  };
  $("btnLogoutAll").onclick = () => {
    if (!window.confirm("이 기기에 저장된 모든 로그인을 지울까요?")) return;
    S.channels = {}; S.current = null; S.sheetAuth = null; persist(); store.del("run");
    $("dlgSettings").close(); render();
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (S.running) requestWake();
      renderAccount();
    }
  });
  window.addEventListener("beforeunload", (e) => { if (S.running && !S.leaving) { e.preventDefault(); e.returnValue = ""; } });
  setInterval(() => {
    if (S.running) return;
    renderAccount();
    if (document.visibilityState === "visible") checkVisibility();   // 5분·24시간 지난 댓글 자동 확인
  }, 60 * 1000);
}

async function safeLoad() {
  try { await loadSheet(); checkVisibility(); }
  catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      showAuthBanner(e.sheet && channel() && valid(channel()) ? "sheet" : "channel");
      if (e.status === 403 && e.sheet) toast("이 계정으로는 시트에 접근할 수 없습니다. 시트를 가진(공유받은) 계정으로 로그인하세요.", 6000);
    } else if (e instanceof ApiError && e.status === 404) {
      toast("시트를 찾을 수 없습니다. 링크를 확인하세요.", 5000);
    } else toast(e.message, 5000);
    setRunText("시트를 불러오지 못했습니다");
    render();
  }
}

// ------------------------------------------------------------------ 시작
async function boot() {
  bind();
  render();
  const r = readOAuthReturn();
  if (r) {
    if (r.ok) {
      try { await finishLogin(r); }
      catch (e) { toast(e.message, 6000); log("로그인 처리 실패", e.message); }
    } else {
      toast(r.error, 6000);
      if (r.silent) showAuthBanner(r.kind === "sheet" ? "sheet" : "channel");
    }
  }
  render();
  if (S.currentSheet && sheetToken()) await safeLoad();
  else if (S.currentSheet && channel()) showAuthBanner(valid(channel()) ? "sheet" : "channel");

  // 로그인 갱신 때문에 잠시 떠났던 실행 이어가기
  const run = store.get("run", null);
  if (run && r && r.ok && run.channelId === S.current && run.sheetId === S.currentSheet && now() - run.at < 3 * 60 * 60 * 1000 && S.sheet && !S.sheet.error) {
    toast("게시를 이어갑니다");
    startRun({ resumed: true }).catch(handleRunError);
  } else if (run && !(r && !r.ok && r.silent)) {
    // 자동 갱신이 실패한 경우만 기록을 남겨 두고(수동 로그인 후 이어가기), 그 외에는 지운다
    store.del("run");
  }
}

boot();
