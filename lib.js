// 유튜브 댓글 도우미 (모바일) — 화면과 무관한 순수 로직. Node 단위 테스트 대상.

export const STATUS = {
  POSTING: "게시 중",
  DONE: "게시 완료",
  FAIL: "실패",
  SKIP: "건너뜀",
  ALREADY: "이미 댓글 단 영상",   // 이 채널로 이미 댓글을 단 영상이라 게시하지 않음 (행 배경 초록)
};

// 앱이 관리하는 열 (없으면 시트 맨 오른쪽에 추가)
export const MANAGED_COLUMNS = ["상태", "게시시각", "댓글링크", "게시채널", "오류", "공개확인", "기존댓글"];

// 행 배경색 (파스텔): 안 보이는 댓글 = 빨강, 이미 댓글 단 영상이라 건너뜀 = 초록
export const COLOR = {
  hidden: { red: 0.957, green: 0.8, blue: 0.8 },        // #F4CCCC
  already: { red: 0.851, green: 0.918, blue: 0.827 },   // #D9EAD3
};

/** 시트 가로줄 하나 전체 배경색 바꾸기 (batchUpdate 요청 1개). row는 1부터 */
export function rowColorRequest(sheetId, row, color) {   // 열 범위를 안 주면 가로줄 전체
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: row - 1, endRowIndex: row },
      cell: { userEnteredFormat: { backgroundColor: color } },
      fields: "userEnteredFormat.backgroundColor",
    },
  };
}

/** '기존댓글' 칸 문구: "또이안이야 · 2026-10-23 01:00 · https://…&lc=…" */
export function alreadyNote(prev, channelTitle) {
  const at = String(prev && prev.at || "").trim();
  const when = /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(at) ? at.slice(0, 16) : (at || "시각 기록 없음");
  return [channelTitle || (prev && prev.channelTitle) || "", when, (prev && prev.link) || ""].filter(Boolean).join(" · ");
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** 유튜브 주소/ID → 11자리 영상 ID (아니면 null) */
export function extractVideoId(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  if (VIDEO_ID_RE.test(s)) return s;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const ok = (id) => (id && VIDEO_ID_RE.test(id) ? id : null);
  if (host === "youtu.be" || host.endsWith(".youtu.be")) {
    return ok(u.pathname.replace(/^\//, "").split("/")[0]);
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (u.pathname.replace(/\/$/, "") === "/watch") return ok(u.searchParams.get("v"));
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && ["shorts", "live", "embed", "v"].includes(parts[0])) return ok(parts[1]);
  }
  return null;
}

export function videoUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** 구글 시트 링크 → { id, gid } (gid는 탭 번호, 없으면 null) */
export function parseSheetUrl(input) {
  const s = String(input || "").trim();
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  let id = m ? m[1] : (/^[A-Za-z0-9_-]{30,}$/.test(s) ? s : null);
  if (!id) return null;
  const g = s.match(/[#?&]gid=(\d+)/);
  return { id, gid: g ? Number(g[1]) : null };
}

/** 0 → A, 25 → Z, 26 → AA */
export function colLetter(index) {
  let n = index + 1, out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 시트 탭 이름을 A1 표기용으로 감싼다 */
export function quoteSheet(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

const norm = (h) => String(h ?? "").trim().toLowerCase().replace(/\s+/g, "");
const COMMENT_HEADERS = ["댓글", "comment", "댓글내용", "댓글텍스트"]; // 정확히 일치만 ("댓글 수" 제외)
const TITLE_HEADERS = ["제목", "title"];
const CHANNEL_HEADERS = ["채널명", "채널", "channel"];

/**
 * 머리글(1행)과 데이터로 열 위치를 찾는다.
 * 반환: { comment, video, title, channel, managed: {상태: idx|-1, ...}, width }
 */
export function findColumns(header, rows) {
  const h = header.map(norm);
  const comment = h.findIndex((x) => COMMENT_HEADERS.includes(x));
  const title = h.findIndex((x) => TITLE_HEADERS.some((k) => x === k || x.startsWith(k)));
  const channel = h.findIndex((x) => CHANNEL_HEADERS.some((k) => x === k || x.startsWith(k)));
  const managed = {};
  for (const name of MANAGED_COLUMNS) managed[name] = h.indexOf(norm(name));

  // 영상 열: 데이터에 유튜브 주소가 가장 많이 들어 있는 열 (댓글·관리 열 제외)
  const width = Math.max(header.length, ...rows.map((r) => r.length), 0);
  const skip = new Set([comment, ...Object.values(managed)].filter((i) => i >= 0));
  let video = -1, best = 0;
  const sample = rows.slice(0, 50);
  for (let c = 0; c < width; c++) {
    if (skip.has(c)) continue;
    const hits = sample.filter((r) => extractVideoId(r[c])).length;
    if (hits > best) { best = hits; video = c; }
  }
  return { comment, video, title, channel, managed, width };
}

/** 관리 열 중 없는 것들을 오른쪽에 배치할 위치 계산. 반환: { 이름: idx } 와 추가할 머리글 목록 */
export function planManagedColumns(header, cols) {
  const pos = { ...cols.managed };
  const add = [];
  let next = header.length;
  for (const name of MANAGED_COLUMNS) {
    if (pos[name] < 0) { pos[name] = next++; add.push({ name, index: pos[name] }); }
  }
  return { pos, add };
}

/**
 * 시트 행들을 분류한다.
 * rows: 1행(머리글) 제외한 데이터 배열. 행 번호는 2부터.
 * 반환: { items: [...], counts }
 *  item.kind: "target"(게시 대상) | "orphan"(게시 중으로 남은 행, 확인 필요) | "done" | "skip" | "fail" | "empty" | "invalid" | "dup"
 */
export function classifyRows(rows, cols, pos) {
  const get = (r, i) => (i >= 0 && i < r.length && r[i] != null ? String(r[i]).trim() : "");
  const items = [];
  const counts = { target: 0, orphan: 0, done: 0, skip: 0, fail: 0, empty: 0, invalid: 0, dup: 0, already: 0 };
  const seen = new Set();      // (영상, 댓글) — 이미 게시했거나 이번에 게시할 조합
  // 1차: 완료된 조합 수집
  rows.forEach((r) => {
    if (get(r, pos["상태"]) === STATUS.DONE) {
      const vid = extractVideoId(get(r, cols.video));
      if (vid) seen.add(vid + "\u0000" + get(r, cols.comment));
    }
  });
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const text = get(r, cols.comment);
    const url = get(r, cols.video);
    const status = get(r, pos["상태"]);
    const vid = extractVideoId(url);
    const base = {
      row: rowNum, text, url, vid, status,
      title: get(r, cols.title), channel: get(r, cols.channel),
      postedAt: get(r, pos["게시시각"]), link: get(r, pos["댓글링크"]),
      postedBy: get(r, pos["게시채널"]), error: get(r, pos["오류"]),
      visibility: get(r, pos["공개확인"]), prevNote: get(r, pos["기존댓글"]),
    };
    let kind;
    if (!text) kind = url || status ? "empty" : null;
    else if (status === STATUS.DONE) kind = "done";
    else if (status === STATUS.SKIP) kind = "skip";
    else if (status === STATUS.ALREADY) kind = "already";
    else if (!vid) kind = "invalid";
    else if (status === STATUS.POSTING) kind = "orphan";
    else {
      const key = vid + "\u0000" + text;
      if (seen.has(key)) kind = "dup";
      else { seen.add(key); kind = status === STATUS.FAIL ? "fail" : "target"; }
    }
    if (!kind) return;               // 완전히 빈 행
    counts[kind]++;
    items.push({ ...base, kind });
  });
  return { items, counts };
}

/** 대기 행들 중 같은 댓글이 여러 영상에 반복되는 문구 */
export function repeatedTexts(items) {
  const n = new Map();
  for (const it of items) if (it.kind === "target" || it.kind === "fail") n.set(it.text, (n.get(it.text) || 0) + 1);
  return [...n].filter(([, c]) => c > 1).map(([t]) => t);
}

/** 할당량 기준일(미국 태평양 시간) 키: "2026-10-22" */
export function quotaDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 한국 시간 표기 "2026-10-23 00:41:05" */
export function kstStamp(date = new Date()) {
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
  return s.replace("T", " ");
}

// 기본 간격: 60~120초 무작위, 10% 확률로 180~240초 긴 휴식
export const DEFAULT_DELAY = { lo: 60, hi: 120 };
export const LONG_PAUSE = { p: 0.1, lo: 180, hi: 240 };

/** 다음 댓글까지 기다릴 초. longPause면 10% 확률로 180~240초 */
export function nextDelay(lo, hi, longPause = true, rnd = Math.random) {
  if (longPause && rnd() < LONG_PAUSE.p) return randomDelay(LONG_PAUSE.lo, LONG_PAUSE.hi, rnd);
  return randomDelay(lo, hi, rnd);
}

export function randomDelay(lo, hi, rnd = Math.random) {
  const a = Math.max(0, Math.min(lo, hi)), b = Math.max(lo, hi, 0);
  return Math.round(a + (b - a) * rnd());
}

/** API 오류 → { code, message } — code: quota | disabled | forbidden | notfound | auth | rate | other */
export function errorReason(status, body) {
  let reason = "", msg = "";
  try {
    const e = (typeof body === "string" ? JSON.parse(body) : body)?.error;
    reason = e?.errors?.[0]?.reason || e?.status || "";
    msg = e?.message || "";
  } catch { /* 본문이 JSON이 아님 */ }
  const all = `${reason} ${msg}`;
  if (status === 401) return { code: "auth", message: "로그인이 만료되었습니다" };
  if (/quotaExceeded|dailyLimitExceeded/.test(all)) return { code: "quota", message: "오늘 API 한도를 다 썼습니다 (한국시간 오후 4~5시경 초기화)" };
  if (/commentsDisabled/.test(all)) return { code: "disabled", message: "댓글이 꺼진 영상입니다" };
  if (/videoNotFound/.test(all) || status === 404) return { code: "notfound", message: "영상을 찾을 수 없습니다" };
  if (/ineligibleAccount/.test(all)) return { code: "forbidden", message: "이 채널은 댓글을 달 수 없습니다" };
  if (/rateLimitExceeded/.test(all) || status === 429) return { code: "rate", message: "요청이 너무 빠릅니다 (간격을 늘려주세요)" };
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(all)) return { code: "scope", message: "권한이 부족합니다 (다시 로그인 필요)" };
  if (status === 403) return { code: "forbidden", message: msg ? `권한 없음: ${msg}` : "권한이 없습니다" };
  return { code: "other", message: (msg || `오류 ${status}`).slice(0, 150) };
}

// ------------------------------------------------------------------ 공개 검사 (로그인 없이 댓글이 보이는지)
// 업로드와 분리된 별도 기능. 시간 조건 없이, 시트에 남은 댓글링크를 지금 바로 검사한다.

/** 댓글링크(…&lc=ID)에서 댓글 스레드 ID */
export function commentIdFromLink(link) {
  const m = String(link || "").match(/[?&]lc=([A-Za-z0-9_.-]+)/);
  return m ? m[1] : null;
}

/** "2026-10-23 00:41:05"(한국 시간) → ms. 형식이 다르면 NaN */
export function parseKst(stamp) {
  const m = String(stamp || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return NaN;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}+09:00`);
}

/**
 * 시트 한 탭에서 검사할 행(댓글링크가 있는 행)을 뽑는다.
 * 반환: { linkCol, visCol(-1이면 없음), rows: [{ row, cid, vid, link, text, title, channel, postedAt, postedBy, visibility }] }
 * '댓글링크' 머리글이 없으면 null
 */
export function linkRows(header, rows) {
  const cols = findColumns(header, rows);
  const linkCol = cols.managed["댓글링크"];
  if (linkCol < 0) return null;
  const get = (r, i) => (i >= 0 && i < r.length && r[i] != null ? String(r[i]).trim() : "");
  const out = [];
  rows.forEach((r, i) => {
    const link = get(r, linkCol);
    const cid = commentIdFromLink(link);
    if (!cid) return;
    out.push({
      row: i + 2, cid, link, vid: extractVideoId(link) || extractVideoId(get(r, cols.video)),
      text: get(r, cols.comment), title: get(r, cols.title), channel: get(r, cols.channel),
      postedAt: get(r, cols.managed["게시시각"]), postedBy: get(r, cols.managed["게시채널"]),
      visibility: get(r, cols.managed["공개확인"]),
    });
  });
  return { linkCol, visCol: cols.managed["공개확인"], rows: out };
}

/**
 * 두 가지 조회 결과를 합쳐 판정.
 *  byId: 댓글 ID로 직접 조회해서 나왔는지 (true/false)
 *  inList: 영상의 '최신순' 공개 댓글 목록에 있었는지 (true/false/null=목록이 길어 거기까지 못 봄)
 *  videoGone: 영상이 없거나 댓글이 꺼져 목록 조회 자체가 실패
 * 반환: "visible" | "hidden" | "mixed" | "gone"
 */
export function visVerdict(byId, inList, videoGone = false) {
  if (videoGone) return byId ? "mixed" : "gone";
  if (inList == null) return byId ? "visible" : "hidden";
  if (byId && inList) return "visible";
  if (!byId && !inList) return "hidden";
  return "mixed";
}

export const VERDICT_WORD = { visible: "보임", hidden: "안 보임", mixed: "엇갈림", gone: "영상/댓글창 없음" };

const shortStamp = (nowMs) => kstStamp(new Date(nowMs)).slice(5, 16).replace("-", "/");   // "10/25 13:00"

/**
 * '공개확인' 칸 해석. 반환 { state, hiddenAt }
 *  hiddenAt: 처음 '안 보임'으로 확인된 시각 문자열("10/25 13:00") — 한 번이라도 안 보였으면 있음.
 *  예전 형식("1차 보임 (…) → 2차 안 보임 (…)", "보임 (…) → 안 보임 (…)")도 읽는다.
 */
export function parseVisibility(v) {
  const text = String(v || "").trim();
  if (!text) return { state: "", hiddenAt: null };
  let hiddenAt = null;
  for (const part of text.split("→")) {
    if (part.includes("안 보임")) {
      const m = part.match(/\(([^)]*)\)/);
      hiddenAt = m ? m[1].replace(/^\s*(최초|최근 확인)\s*/, "").trim() : "";
      break;
    }
  }
  if (hiddenAt != null) return { state: "hidden", hiddenAt };
  const last = text.split("→").pop();
  const state = last.includes("엇갈림") ? "mixed" : last.includes("영상/댓글창 없음") ? "gone" : last.includes("보임") ? "visible" : "";
  return { state, hiddenAt: null };
}

/**
 * 검사 결과로 '공개확인' 칸을 최신 상태로 바꾼다 (이력을 쌓지 않음).
 *  - 한 번 안 보인 댓글: "안 보임 (최초 10/25 13:00)" — 처음 안 보인 시각을 고정, 이후 검사해도 안 바뀜
 *  - 그 외: "보임 (최근 확인 10/25 14:00)" 처럼 마지막 검사 결과와 시각
 */
export function nextVisibility(prev, verdict, nowMs = Date.now()) {
  const p = parseVisibility(prev);
  if (p.hiddenAt != null) return `안 보임 (최초 ${p.hiddenAt || shortStamp(nowMs)})`;
  if (verdict === "hidden") return `안 보임 (최초 ${shortStamp(nowMs)})`;
  return `${VERDICT_WORD[verdict] || verdict} (최근 확인 ${shortStamp(nowMs)})`;
}

/** 마지막 상태: "visible" | "hidden" | "mixed" | "gone" | "" (한 번이라도 안 보였으면 hidden) */
export function visibilityState(v) {
  return parseVisibility(v).state;
}

/** 시트 제목 그대로, 없으면 ID 앞부분 */
export function sheetLabel(ref) {
  return (ref && ref.title) || (ref && ref.id ? ref.id.slice(0, 12) + "…" : "");
}

// ------------------------------------------------------------------ 업로드 기록 (채널별 중복 방지)
// 시트 계정 드라이브의 시트 하나에 모든 채널의 게시 기록을 모은다. 중복 기준: (채널 + 영상)

export const RECORD_TITLE = "댓글 업로드 기록 (댓글 도우미)";
export const RECORD_TAB = "기록";
export const RECORD_HEADER = ["게시시각", "채널ID", "채널명", "영상ID", "영상 제목", "영상 채널", "댓글", "댓글링크", "원본 시트"];

const normTitle = (t) => String(t || "").trim().replace(/^@/, "").toLowerCase();

/**
 * 기록 시트 값(1행 머리글 포함) → 색인.
 * 사람이 직접 적은 행도 읽는다: 채널ID가 비어 있으면 채널명으로, 영상ID가 비어 있으면 댓글링크/영상 주소에서.
 * 반환 { rows: [{at, channelId, channelTitle, vid, link}], has(ch, vid) → 행|null, count }
 */
export function recordIndex(values) {
  const header = (values[0] || []).map((h) => String(h || "").trim());
  const col = (name) => header.indexOf(name);
  const c = { at: col("게시시각"), id: col("채널ID"), title: col("채널명"), vid: col("영상ID"), link: col("댓글링크") };
  const get = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : "");
  const byId = new Map(), byTitle = new Map(), rows = [];
  for (const r of values.slice(1)) {
    let vid = extractVideoId(get(r, c.vid)) || extractVideoId(get(r, c.link));
    if (!vid) for (const cell of r) { vid = extractVideoId(cell); if (vid) break; }   // 영상 주소를 아무 칸에나 적어도
    const channelId = get(r, c.id), channelTitle = get(r, c.title);
    if (!vid || (!channelId && !channelTitle)) continue;
    const row = { at: get(r, c.at), channelId, channelTitle, vid, link: get(r, c.link) };
    rows.push(row);
    if (channelId && !byId.has(channelId + "|" + vid)) byId.set(channelId + "|" + vid, row);
    if (channelTitle && !byTitle.has(normTitle(channelTitle) + "|" + vid)) byTitle.set(normTitle(channelTitle) + "|" + vid, row);
  }
  const has = (ch, vid) => {
    if (!ch || !vid) return null;
    return (ch.id && byId.get(ch.id + "|" + vid)) || (ch.title && byTitle.get(normTitle(ch.title) + "|" + vid))
      || (ch.handle && byTitle.get(normTitle(ch.handle) + "|" + vid)) || null;
  };
  const add = (row) => {
    rows.push(row);
    if (row.channelId) byId.set(row.channelId + "|" + row.vid, row);
    if (row.channelTitle) byTitle.set(normTitle(row.channelTitle) + "|" + row.vid, row);
  };
  return { rows, has, add, get count() { return rows.length; } };
}

/** 게시 1건 → 기록 시트 한 행 */
export function recordRow({ at, channelId, channelTitle, vid, title, videoChannel, text, link, sheet }) {
  return [at || "", channelId || "", channelTitle || "", vid || "", title || "", videoChannel || "", text || "", link || "", sheet || ""];
}

/**
 * 업로드 시트의 '게시 완료' 행 중 기록에 없는 것 (기록 기능 전에 올린 것 채우기).
 * channels: { channelId: {title, handle} } — 게시채널(이름)을 채널ID로 바꾸는 데 쓴다.
 */
export function missingRecordRows(items, index, channels, sheetTitle) {
  const byTitle = new Map(Object.entries(channels || {}).map(([id, c]) => [normTitle(c.title), id]));
  const out = [], seen = new Set();
  for (const it of items) {
    if (it.kind !== "done" || !it.vid || !it.postedBy) continue;
    const channelId = byTitle.get(normTitle(it.postedBy)) || "";
    const ch = { id: channelId, title: it.postedBy };
    const key = (channelId || normTitle(it.postedBy)) + "|" + it.vid;
    if (index.has(ch, it.vid) || seen.has(key)) continue;
    seen.add(key);
    out.push({ at: it.postedAt, channelId, channelTitle: it.postedBy, vid: it.vid, title: it.title, videoChannel: it.channel, text: it.text, link: it.link, sheet: sheetTitle });
  }
  return out;
}

/** 표 → CSV (엑셀에서 한글 깨지지 않게 BOM 포함) */
export function toCsv(rows) {
  const cell = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** 파일 이름에 못 쓰는 글자 제거 */
export function safeFileName(s) {
  return String(s || "이름없음").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60) || "이름없음";
}

/** 기록 시트 값 → 백업 파일들 { 파일이름: CSV } (전체 + 채널별) */
export function backupFiles(values) {
  const header = values[0] && values[0].length ? values[0] : RECORD_HEADER;
  const body = values.slice(1).filter((r) => r.some((x) => String(x ?? "").trim()));
  const files = { "댓글업로드기록_전체.csv": toCsv([header, ...body]) };
  const ti = header.indexOf("채널명"), ii = header.indexOf("채널ID");
  const groups = new Map();
  for (const r of body) {
    const name = String(r[ti] || r[ii] || "채널미상").trim();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(r);
  }
  for (const [name, rows] of groups) files[`댓글업로드기록_${safeFileName(name)}.csv`] = toCsv([header, ...rows]);
  return files;
}
