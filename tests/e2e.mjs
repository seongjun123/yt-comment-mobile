// 화면 흐름 테스트: 구글 엔드포인트를 전부 가짜로 대체하고 실제 브라우저(Chromium, 폰 크기)로 앱을 돌린다.
// 실행: (앱 폴더에서) python3 -m http.server 5173 & ; node tests/e2e.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/opt/npm-tools/node_modules/playwright");

const BASE = "http://localhost:5173/";
const OUT = process.env.SHOTS || "/tmp/e2e-shots";
fs.mkdirSync(OUT, { recursive: true });
const SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";

// ---------------- 가짜 구글 ----------------
const accounts = {
  me: { token: "tok-me", email: "yunsj7060@gmail.com", channel: { id: "UC_ME", title: "yun sj", customUrl: "@yunsj" } },
  brand: { token: "tok-brand", email: "", channel: { id: "UC_BRAND", title: "또이안이야", customUrl: "@또이안이야" } },
  sheet: { token: "tok-sheet", email: "yunsj7060@gmail.com" },
};
let pick = "me";            // 다음 로그인에서 고를 계정
let silentFails = false;    // prompt=none 실패 흉내
let forceSilentKey = null;  // 자동 갱신이 다른 채널로 돌아오는 경우 흉내
let nextExpires = null;     // 다음 로그인 토큰의 유효 시간(초) 한 번만 바꾸기
const silentHints = [];
let tokenSeq = 0;
const tokenOwner = {};      // token → 계정 키

const header = ["채널명", "제목", "조회수", "구독자", "업로드 날짜", "영상 링크", "댓글"];
const mk = (ch, t, vid, c) => [ch, t, "1", "1", "2026-10-22", `https://www.youtube.com/watch?v=${vid}`, c];
let grid = [
  header,
  mk("아름약사", "혈당 영상", "dpjYK2UuYAY", "좋은 정보 감사해요"),
  mk("고재영", "무인도", "HuaGOfzVBiU", ""),
  mk("정육왕", "보섭살", "_njE1rfRTU0", "고기 진짜 잘구우시네"),
  mk("X", "꺼진 영상", "BBBBBBBBBBB", "꺼진 곳"),
  mk("Y", "없는 영상", "AAAAAAAAAAA", "없는 곳"),
];
let colCount = 7;
const videos = {
  dpjYK2UuYAY: { t: "혈당 영상", c: "아름약사", on: true },
  HuaGOfzVBiU: { t: "무인도", c: "고재영", on: true },
  _njE1rfRTU0: { t: "보섭살", c: "정육왕", on: true },
  BBBBBBBBBBB: { t: "꺼진 영상", c: "X", on: false },
  CCCCCCCCCCC: { t: "C 영상", c: "C", on: true },
  DDDDDDDDDDD: { t: "D 영상", c: "D", on: true },
  EEEEEEEEEEE: { t: "E 영상", c: "E", on: true },
  FFFFFFFFFFF: { t: "F 영상", c: "F", on: true },
  GGGGGGGGGGG: { t: "G 영상", c: "G", on: true },
  HHHHHHHHHHH: { t: "H 영상", c: "H", on: true },
};
const posted = [];          // {by, vid, text, id}
const hiddenIds = new Set(); // 남에게 안 보이는 댓글 (ID 조회에서 안 나옴)
const listHidden = new Set(); // 최신순 목록에서만 안 나오는 댓글 (엇갈림 흉내)
let listCalls = 0;
const REC_ID = "1RecordSheetIdRecordSheetIdRecord000000000";
let recordExists = true;   // 기본: 이미 있음 (만들기 확인 창은 따로 테스트)
let recordGrid = [];
let driveCalls = 0;
let publicCalls = 0;

function colIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function setCell(a1, v) {
  const m = a1.match(/!([A-Z]+)(\d+)$/);
  const c = colIndex(m[1]), r = Number(m[2]) - 1;
  if (c >= colCount) throw new Error("exceeds grid limits");
  while (grid.length <= r) grid.push([]);
  while (grid[r].length <= c) grid[r].push("");
  grid[r][c] = v;
}
const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const who = (req) => tokenOwner[(req.headers()["authorization"] || "").replace("Bearer ", "")];

async function installMocks(page) {
  await page.route("https://accounts.google.com/**", (route) => {
    const u = new URL(route.request().url());
    const p = u.searchParams;
    const redirect = p.get("redirect_uri"), state = p.get("state");
    if (p.get("prompt") === "none") { silentHints.push(p.get("login_hint") || ""); if (process.env.DBG) console.log("SILENT", p.get("scope").includes("youtube") ? "channel" : "sheet", p.get("login_hint"), silentFails); }
    if (p.get("prompt") === "none" && silentFails) {
      return route.fulfill({ status: 302, headers: { location: `${redirect}#error=interaction_required&state=${state}` } });
    }
    const isSheet = !p.get("scope").includes("youtube");
    const key = isSheet ? "sheet" : (p.get("prompt") === "none" ? (forceSilentKey || tokenOwner.lastChannelKey || pick) : pick);
    const tok = `${accounts[key].token}-${++tokenSeq}`;
    tokenOwner[tok] = key;
    if (!isSheet) tokenOwner.lastChannelKey = key;
    const frag = new URLSearchParams({ access_token: tok, expires_in: String(nextExpires || 3599), token_type: "Bearer", scope: p.get("scope").replace("openid email", "openid https://www.googleapis.com/auth/userinfo.email"), state });
    nextExpires = null;
    route.fulfill({ status: 302, headers: { location: `${redirect}#${frag}` } });
  });
  await page.route("https://openidconnect.googleapis.com/**", (route) => {
    const k = who(route.request());
    if (!k) return json(route, 401, {});
    json(route, 200, { email: accounts[k].email || undefined, sub: "sub-" + k });
  });
  await page.route("https://www.googleapis.com/youtube/v3/**", (route) => {
    const req = route.request(), u = new URL(req.url()), k = who(req);
    if (!k && u.searchParams.get("key") && u.pathname.endsWith("/commentThreads") && u.searchParams.get("id")) {
      publicCalls++;
      const ids = u.searchParams.get("id").split(",");
      return json(route, 200, { items: ids.filter((id) => posted.some((p) => p.id === id) && !hiddenIds.has(id)).map((id) => ({ id })) });
    }
    if (!k && u.searchParams.get("key") && u.pathname.endsWith("/commentThreads") && u.searchParams.get("videoId")) {
      listCalls++;
      const vid = u.searchParams.get("videoId");
      if (videos[vid] && !videos[vid].on) return json(route, 403, { error: { errors: [{ reason: "commentsDisabled" }], message: "disabled" } });
      const items = posted.filter((x) => x.vid === vid && !hiddenIds.has(x.id) && !listHidden.has(x.id)).reverse()
        .map((x) => ({ id: x.id, snippet: { topLevelComment: { snippet: { publishedAt: new Date().toISOString(), textOriginal: x.text } } } }));
      return json(route, 200, { items });
    }
    if (!k) return json(route, 401, { error: { message: "auth" } });
    if (k === "sheet") return json(route, 403, { error: { errors: [{ reason: "insufficientPermissions" }], message: "scope" } });
    const me = accounts[k].channel;
    if (u.pathname.endsWith("/channels")) {
      return json(route, 200, { items: [{ id: me.id, snippet: { title: me.title, customUrl: me.customUrl, thumbnails: { default: { url: "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=" } } } }] });
    }
    if (u.pathname.endsWith("/videos")) {
      const ids = u.searchParams.get("id").split(",");
      return json(route, 200, { items: ids.filter((i) => videos[i]).map((i) => ({ id: i, snippet: { title: videos[i].t, channelTitle: videos[i].c }, statistics: videos[i].on ? { commentCount: "3" } : {} })) });
    }
    if (u.pathname.endsWith("/commentThreads") && req.method() === "POST") {
      const b = JSON.parse(req.postData());
      const id = `cmt${posted.length + 1}`;
      posted.push({ by: me.id, vid: b.snippet.videoId, text: b.snippet.topLevelComment.snippet.textOriginal, id });
      return json(route, 200, { id });
    }
    if (u.pathname.endsWith("/commentThreads")) {
      const vid = u.searchParams.get("videoId");
      const items = posted.filter((x) => x.vid === vid).map((x) => ({ id: x.id, snippet: { topLevelComment: { snippet: { authorChannelId: { value: x.by }, textOriginal: x.text } } } }));
      return json(route, 200, { items });
    }
    json(route, 404, {});
  });
  await page.route("https://www.googleapis.com/drive/v3/**", (route) => {
    const req = route.request(), k = who(req);
    if (!k) return json(route, 401, { error: { message: "auth" } });
    if (k === "brand") return json(route, 403, { error: { message: "brand" } });
    driveCalls++;
    json(route, 200, { files: recordExists ? [{ id: REC_ID, name: "댓글 업로드 기록 (댓글 도우미)" }] : [] });
  });
  await page.route("https://sheets.googleapis.com/**", (route) => {
    const req = route.request(), u = new URL(req.url()), k = who(req);
    if (!k) return json(route, 401, { error: { message: "auth" } });
    if (k === "brand") return json(route, 403, { error: { status: "PERMISSION_DENIED", message: "The caller does not have permission" } });
    const path = decodeURIComponent(u.pathname);
    if (path.endsWith("/v4/spreadsheets") && req.method() === "POST") { recordExists = true; recordGrid = []; return json(route, 200, { spreadsheetId: REC_ID }); }
    if (path.includes(`/spreadsheets/${REC_ID}`)) {
      if (!recordExists) return json(route, 404, { error: { message: "nf" } });
      if (path.endsWith(":append")) { recordGrid.push(...JSON.parse(req.postData()).values); return json(route, 200, {}); }
      if (req.method() === "PUT") { recordGrid[0] = JSON.parse(req.postData()).values[0]; return json(route, 200, {}); }
      return json(route, 200, { values: recordGrid.map((r) => [...r]) });
    }
    if (path.endsWith(`/spreadsheets/${SHEET_ID}`)) {
      return json(route, 200, { properties: { title: "관제탑_롱폼" }, sheets: [{ properties: { sheetId: 0, title: "시트1", index: 0, gridProperties: { columnCount: colCount } } }] });
    }
    if (path.includes("/values/") && req.method() === "GET") return json(route, 200, { values: grid.map((r) => [...r]) });
    if (path.endsWith("/values:batchGet")) return json(route, 200, { valueRanges: [{ values: grid.map((r) => [...r]) }] });
    if (path.endsWith(":batchUpdate") && path.includes("/values")) {
      try { for (const d of JSON.parse(req.postData()).data) setCell(d.range, d.values[0][0]); }
      catch (e) { return json(route, 400, { error: { message: e.message } }); }
      return json(route, 200, {});
    }
    if (path.endsWith(":batchUpdate")) {
      for (const r of JSON.parse(req.postData()).requests) if (r.appendDimension) colCount += r.appendDimension.length;
      return json(route, 200, {});
    }
    json(route, 404, {});
  });
}

// ---------------- 시나리오 ----------------
const results = [];
const check = (name, cond, extra = "") => { results.push([cond ? "PASS" : "FAIL", name, extra]); if (!cond) console.log("FAIL:", name, extra); };
const H = () => grid[0];
const cell = (row, name) => (grid[row - 1] || [])[H().indexOf(name)] || "";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ko-KR" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("dialog", (d) => d.accept());
await installMocks(page);

await page.goto(BASE);
await page.screenshot({ path: `${OUT}/01-first.png` });

// 1) 본계정 채널 로그인
pick = "me";
await page.click("#btnLogin");
await page.waitForFunction(() => document.querySelector("#acctTitle").textContent === "yun sj");
check("본계정 로그인 후 채널명 표시", true);
check("이메일 표시", (await page.textContent("#acctSub")).includes("yunsj7060@gmail.com"));
check("시트 계정 자동 설정", (await page.textContent("#sheetAuth")).includes("yunsj7060@gmail.com"));
check("주소창에서 토큰 제거", !page.url().includes("access_token"), page.url());

// 2) 시트 등록
await page.click("#btnAddSheet");
await page.fill("#inpSheet", `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`);
await page.click("#formAddSheet button[type=submit]");
await page.waitForSelector(".item");
await page.screenshot({ path: `${OUT}/02-sheet-loaded.png`, fullPage: true });
const pendingCount = await page.locator(".item").count();
check("대기 행 4개 (댓글 빈 행 제외)", pendingCount === 4, String(pendingCount));

// 간격 0초
await page.click("#btnSettings");
check("기본 간격 60~120초", (await page.inputValue("#inpLo")) === "60" && (await page.inputValue("#inpHi")) === "120");
check("긴 휴식 기본 켜짐", await page.isChecked("#chkLong"));
await page.fill("#inpLo", "0"); await page.fill("#inpHi", "0"); await page.uncheck("#chkLong");
await page.click("#btnSettingsSave");

// 3) 게시
await page.click("#btnStart");
await page.waitForSelector("#dlgConfirm[open]");
await page.screenshot({ path: `${OUT}/03-confirm.png` });
await page.click("#dlgOk");
await page.waitForFunction(() => document.querySelector("#dlgTitle").textContent === "결과" && document.querySelector("#dlgConfirm").open, null, { timeout: 20000 });
await page.screenshot({ path: `${OUT}/04-result.png` });
await page.click("#dlgOk");
check("2건 게시", posted.length === 2, JSON.stringify(posted));
check("관리 열 추가", H().slice(7).join(",") === "상태,게시시각,댓글링크,게시채널,오류,공개확인", H().join(","));
check("2행 게시 완료", cell(2, "상태") === "게시 완료" && cell(2, "댓글링크").includes("&lc=cmt"), cell(2, "상태"));
check("2행 게시채널", cell(2, "게시채널") === "yun sj");
check("3행(댓글 없음) 그대로", cell(3, "상태") === "");
check("5행 댓글 꺼짐 → 건너뜀", cell(5, "상태") === "건너뜀", cell(5, "오류"));
check("6행 없는 영상 → 건너뜀", cell(6, "상태") === "건너뜀", cell(6, "오류"));
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/05-after.png`, fullPage: true });

// 4) 다시 시작해도 중복 게시 없음
check("다시 시작 버튼 비활성(대기 없음)", await page.isDisabled("#btnStart"));

// 5) 브랜드 채널 추가 → 시트는 본계정 토큰으로 계속 읽힘
grid.push(mk("C", "C 영상", "CCCCCCCCCCC", "브랜드로 다는 댓글"));
pick = "brand";
await page.selectOption("#selChannel", "__add");
await page.waitForFunction(() => document.querySelector("#acctTitle").textContent === "또이안이야");
await page.waitForSelector(".item");
check("브랜드 채널 표시", (await page.textContent("#acctSub")).includes("브랜드 채널"));
check("시트 계정은 본계정 유지", (await page.textContent("#sheetAuth")).includes("yunsj7060@gmail.com"));
await page.click("#btnStart");
await page.waitForSelector("#dlgConfirm[open]");
check("확인 창에 브랜드 채널명", (await page.textContent("#dlgBody")).includes("또이안이야"));
await page.click("#dlgOk");
await page.waitForFunction(() => document.querySelector("#dlgTitle").textContent === "결과" && document.querySelector("#dlgConfirm").open, null, { timeout: 20000 });
await page.click("#dlgOk");
check("브랜드로 게시", posted.at(-1).by === "UC_BRAND" && posted.at(-1).vid === "CCCCCCCCCCC");
check("게시채널=또이안이야", cell(grid.length, "게시채널") === "또이안이야");

// 6) 끊긴 행 복구: 이미 달린 댓글은 다시 달지 않음
grid.push(mk("D", "D 영상", "DDDDDDDDDDD", "끊겼던 댓글"));
const orphanRow = grid.length;
setCell(`x!${String.fromCharCode(65 + H().indexOf("상태"))}${orphanRow}`, "게시 중");
posted.push({ by: "UC_BRAND", vid: "DDDDDDDDDDD", text: "끊겼던 댓글", id: "cmtOld" });
const before = posted.length;
await page.click("#btnRefresh");
await page.waitForSelector(".item");
await page.click("#btnStart");
await page.waitForTimeout(1500);
check("끊긴 행 → 게시 완료로 보정", cell(orphanRow, "상태") === "게시 완료" && cell(orphanRow, "댓글링크").includes("cmtOld"), cell(orphanRow, "상태"));
check("끊긴 행 재게시 안 함", posted.length === before);

// 7) 토큰 만료 직전 → 자동 갱신 후 이어서 게시
grid.push(mk("A", "혈당 영상", "dpjYK2UuYAY", "자동 갱신 테스트"));
await page.evaluate(() => {
  const ch = JSON.parse(localStorage.getItem("ytm.channels"));
  const cur = JSON.parse(localStorage.getItem("ytm.current"));
  ch[cur].exp = Date.now() + 2 * 60 * 1000;      // 2분 남음 (갱신 기준 3분)
  localStorage.setItem("ytm.channels", JSON.stringify(ch));
});
await page.reload();
await page.waitForSelector(".item");
const n0 = posted.length;
await page.click("#btnStart");
await page.waitForSelector("#dlgConfirm[open]");
await page.click("#dlgOk");
await page.waitForFunction((n) => true, n0);
await page.waitForFunction(() => document.querySelector("#dlgTitle")?.textContent === "결과" && document.querySelector("#dlgConfirm")?.open, null, { timeout: 20000 });
check("자동 갱신 후 이어서 게시", posted.length === n0 + 1 && posted.at(-1).text === "자동 갱신 테스트", String(posted.length - n0));
await page.click("#dlgOk");

// 8) 로그인 유지: 앱을 열 때 토큰이 끝나 있으면 누르지 않아도 자동 갱신 (브랜드 채널은 sub로 지정)
const expire = (ms) => page.evaluate((ms) => {
  const ch = JSON.parse(localStorage.getItem("ytm.channels"));
  const cur = JSON.parse(localStorage.getItem("ytm.current"));
  ch[cur].exp = Date.now() + ms;
  localStorage.setItem("ytm.channels", JSON.stringify(ch));
  localStorage.removeItem("ytm.silentTry");
}, ms);
await expire(-60 * 60e3);                     // 1시간 전에 만료
const hintsBefore = silentHints.length;
await page.reload();
await page.waitForFunction(() => document.querySelector("#acctSub")?.textContent.includes("로그인 유지 중"), null, { timeout: 10000 });
check("열 때 자동 갱신 (버튼 안 누름)", silentHints.length === hintsBefore + 1);
check("브랜드 채널은 sub로 자동 갱신", silentHints.at(-1) === "sub-brand", silentHints.at(-1));
check("자동 갱신 후 채널 유지", (await page.textContent("#acctTitle")) === "또이안이야");
check("자동 갱신 후 주소창 깨끗", !page.url().includes("#"), page.url());

// 8-2) 자동 갱신 실패 → 무한 반복 없이 배너, 수동 로그인 후 이어서 게시
grid.push(mk("B", "무인도", "HuaGOfzVBiU", "수동 갱신 테스트"));
await expire(-60e3);
silentFails = true;
const h2 = silentHints.length;
await page.reload();
await page.waitForSelector("#authBanner:not(.hidden)", { timeout: 10000 });
await page.waitForTimeout(1500);
check("자동 갱신 실패 시 1번만 시도", silentHints.length === h2 + 1, String(silentHints.length - h2));
await page.screenshot({ path: `${OUT}/06-relogin-banner.png` });
silentFails = false;
const n1 = posted.length;
await page.click("#btnStart").catch(() => {});      // 만료 상태라 비활성일 수 있음
await page.click("#btnRelogin");
await page.waitForFunction(() => document.querySelector("#acctSub")?.textContent.includes("로그인 유지 중"), null, { timeout: 10000 });
await page.waitForSelector(".item");
await page.click("#btnStart");
await page.waitForSelector("#dlgConfirm[open]");
await page.click("#dlgOk");
await page.waitForFunction(() => document.querySelector("#dlgTitle")?.textContent === "결과" && document.querySelector("#dlgConfirm")?.open, null, { timeout: 20000 });
check("수동 로그인 후 게시", posted.length === n1 + 1 && posted.at(-1).text === "수동 갱신 테스트", String(posted.length - n1));
await page.click("#dlgOk");

// 8-3) 시작 버튼을 눌렀을 때 곧 만료면: 갱신 → 돌아와서 확인 창 → 게시
grid.push(mk("E", "E 영상", "EEEEEEEEEEE", "시작 시 갱신 테스트"));
nextExpires = 186;                            // 3분 6초짜리 토큰으로 로그인 → 몇 초 뒤 '곧 만료'
await page.click("#btnLogin");
await page.waitForFunction(() => document.querySelector("#acctSub")?.textContent.includes("로그인 유지 중"), null, { timeout: 10000 });
await page.waitForSelector(".item");
await page.waitForTimeout(7000);
const n2 = posted.length, h3 = silentHints.length;
await page.click("#btnStart");
await page.waitForSelector("#dlgConfirm[open]", { timeout: 10000 });
check("시작 시 자동 갱신 후 확인 창", silentHints.length === h3 + 1 && (await page.textContent("#dlgTitle")) === "게시할까요?");
await page.click("#dlgOk");
await page.waitForFunction(() => document.querySelector("#dlgTitle")?.textContent === "결과" && document.querySelector("#dlgConfirm")?.open, null, { timeout: 20000 });
check("갱신 후 게시", posted.length === n2 + 1, String(posted.length - n2));
await page.click("#dlgOk");

// 8-4) 자동 갱신이 다른 채널로 돌아오면 원래 채널 유지 + 배너
await expire(-60e3);
forceSilentKey = "me";
await page.reload();
await page.waitForSelector("#authBanner:not(.hidden)", { timeout: 10000 });
check("다른 채널로 갱신돼도 원래 채널 유지", (await page.textContent("#acctTitle")) === "또이안이야");
forceSilentKey = null;
await page.click("#btnRelogin");
await page.waitForFunction(() => document.querySelector("#acctSub")?.textContent.includes("로그인 유지 중"), null, { timeout: 10000 });
await page.waitForSelector(".item, #emptyMsg:not(.hidden)");

// 8-5) 업로드 기록 · 채널별 중복 방지
const recIdx = (name) => (recordGrid[0] || []).indexOf(name);
check("기록 시트 머리글", (recordGrid[0] || []).join(",") === "게시시각,채널ID,채널명,영상ID,영상 제목,영상 채널,댓글,댓글링크,원본 시트", (recordGrid[0] || []).join(","));
check("게시마다 기록 (채널ID 포함)", recordGrid.length - 1 === posted.filter((p) => p.id !== "cmtOld").length + 1
  && recordGrid.slice(1).every((r) => r[recIdx("채널ID")].startsWith("UC_")), `${recordGrid.length - 1} vs ${posted.length}`);
check("끊긴 행 복구분도 기록", recordGrid.some((r) => r[recIdx("영상ID")] === "DDDDDDDDDDD" && r[recIdx("채널ID")] === "UC_BRAND"));
// 지금 채널 = 또이안이야. C 영상엔 이미 달았음 → 건너뜀
grid.push(mk("C", "C 영상", "CCCCCCCCCCC", "또 달면 안 되는 댓글"));
const dupRow = grid.length;
grid.push(mk("F", "F 영상", "FFFFFFFFFFF", "F 첫 댓글"));
grid.push(mk("F", "F 영상", "FFFFFFFFFFF", "F 두 번째 (막혀야 함)"));
const f2Row = grid.length;
recordGrid.push(["", "", "또이안이야", "", "", "", "", "https://youtu.be/GGGGGGGGGGG", ""]);   // 손으로 적은 기록
grid.push(mk("G", "G 영상", "GGGGGGGGGGG", "수동 기록 영상 (막혀야 함)"));
const gRow = grid.length;
await page.click("#btnRefresh");
await page.waitForSelector(".item");
await page.waitForTimeout(800);
check("목록에 '이미 단 영상' 표시", (await page.textContent("#list")).includes("이미 단 영상"));
const p0 = posted.length;
await page.click("#btnStart");
await page.waitForSelector("#dlgConfirm[open]");
check("확인 창에 이미 단 영상 안내", (await page.textContent("#dlgBody")).includes("이미 댓글 단 영상 2개") && (await page.textContent("#dlgBody")).includes("반복된 1개"), await page.textContent("#dlgBody"));
await page.click("#dlgOk");
await page.waitForFunction(() => document.querySelector("#dlgTitle")?.textContent === "결과" && document.querySelector("#dlgConfirm")?.open, null, { timeout: 20000 });
await page.click("#dlgOk");
check("같은 채널·같은 영상은 안 달림", posted.length === p0 + 1 && posted.at(-1).vid === "FFFFFFFFFFF", posted.slice(p0).map((p) => p.vid).join(","));
check("이미 단 영상 → 건너뜀 + 이유", cell(dupRow, "상태") === "건너뜀" && /또이안이야 채널로 이미 댓글 단 영상 \(\d\d\/\d\d \d\d:\d\d\)/.test(cell(dupRow, "오류")), cell(dupRow, "오류"));
check("시트 안 같은 영상 두 번째 → 건너뜀", cell(f2Row, "상태") === "건너뜀" && cell(f2Row, "오류").includes("채널당 1번"), cell(f2Row, "오류"));
check("손으로 적은 기록도 막음", cell(gRow, "상태") === "건너뜀", cell(gRow, "오류"));
// 다른 채널(yun sj)은 같은 영상에 한 번 달 수 있음
grid.push(mk("C", "C 영상", "CCCCCCCCCCC", "yun sj는 처음"));
await page.selectOption("#selChannel", "UC_ME");
await page.waitForFunction(() => document.querySelector("#acctTitle").textContent === "yun sj");
await page.click("#btnRefresh");
await page.waitForSelector(".item");
await page.click("#btnStart");
await page.waitForSelector("#dlgConfirm[open]");
await page.click("#dlgOk");
await page.waitForFunction(() => document.querySelector("#dlgTitle")?.textContent === "결과" && document.querySelector("#dlgConfirm")?.open, null, { timeout: 20000 });
await page.click("#dlgOk");
check("다른 채널은 같은 영상에 1번 가능", posted.at(-1).vid === "CCCCCCCCCCC" && posted.at(-1).by === "UC_ME");
check("시트 저장 계정 표시·고정", (await page.textContent("#sheetAuth")).includes("시트 저장 계정") && (await page.textContent("#sheetAuth")).includes("yunsj7060@gmail.com"));
// 기록 시트가 없으면: 계정 확인 창 → 취소하면 게시 안 함 → 만들기 누르면 생성 + 기존 게시분 채움
recordExists = false; recordGrid = [];
await page.evaluate(() => localStorage.removeItem("ytm.record"));
grid.push(mk("H", "H 영상", "HHHHHHHHHHH", "기록 시트 새로 만든 뒤"));
await page.click("#btnRefresh");
await page.waitForSelector(".item");
const p1 = posted.length;
await page.click("#btnStart");
await page.waitForSelector("#dlgConfirm[open]");
check("새 기록 시트 만들기 전 계정 확인", (await page.textContent("#dlgTitle")) === "업로드 기록 시트 만들기" && (await page.textContent("#dlgBody")).includes("yunsj7060@gmail.com"));
await page.click('#dlgConfirm button[value="cancel"]');
await page.waitForTimeout(600);
check("취소하면 만들지도 게시하지도 않음", !recordExists && posted.length === p1);
await page.click("#btnStart");
await page.waitForSelector("#dlgConfirm[open]");
await page.click("#dlgOk");                          // 만들기
await page.waitForFunction(() => document.querySelector("#dlgTitle")?.textContent === "게시할까요?", null, { timeout: 10000 });
await page.click("#dlgOk");
await page.waitForFunction(() => document.querySelector("#dlgTitle")?.textContent === "결과" && document.querySelector("#dlgConfirm")?.open, null, { timeout: 20000 });
await page.click("#dlgOk");
check("새 기록 시트 생성 + 게시", recordExists && posted.at(-1).vid === "HHHHHHHHHHH");
check("기존 시트의 게시 완료분을 새 기록에 채움", recordGrid.length - 1 >= 6 && recordGrid.some((r) => r[recIdx("영상ID")] === "dpjYK2UuYAY" && r[recIdx("채널ID")] === "UC_ME"), String(recordGrid.length - 1));
// 설정에 기록 표시
await page.click("#btnSettings");
await page.waitForTimeout(300);
check("설정에 기록 건수·시트 링크", (await page.textContent("#recordText")).includes("건") && !(await page.getAttribute("#lnkRecord", "hidden") !== null), await page.textContent("#recordText"));
await page.screenshot({ path: `${OUT}/06b-settings-record.png` });
await page.click("#btnSettingsSave");

// 9) 공개 검사 (별도 모드): 시트 링크 넣고 지금 바로 검사
check("업로드 화면에는 공개 확인 버튼 없음", (await page.locator("#btnVis").count()) === 0);
check("업로드 화면에 숨김 탭 없음", (await page.locator('.tab[data-filter="hidden"]').count()) === 0);
await page.click('.mode[data-mode="check"]');
check("공개 검사 모드에선 게시 바 숨김", !(await page.isVisible(".runbar")));
check("업로드 화면 숨김", !(await page.isVisible("#sheetCard")));
await page.fill("#inpCheck", `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`);
await page.click("#formCheckAdd button[type=submit]");
await page.waitForSelector(".sheet-card");
check("시트 이름 그대로 표시", (await page.textContent(".sheet-card .title")).includes("관제탑_롱폼"), await page.textContent(".sheet-card .title"));
await page.fill("#inpCheck", "아무거나");
await page.click("#formCheckAdd button[type=submit]");
check("잘못된 링크 거부", (await page.locator(".sheet-card").count()) === 1);
const doneRows = grid.slice(1).map((r, i) => i + 2).filter((row) => cell(row, "댓글링크").includes("lc="));
const vidOf = (row) => cell(row, "댓글링크").match(/v=([\w-]{11})/)[1];
const idOf = (row) => cell(row, "댓글링크").match(/lc=([\w.-]+)/)[1];
check("검사 대상 행 3개 이상", doneRows.length >= 3, doneRows.join(","));
const [rv, rh, rm] = doneRows;
hiddenIds.clear(); listHidden.clear();
hiddenIds.add(idOf(rh));          // 숨김 → 안 보임
listHidden.add(idOf(rm));         // ID로는 나오는데 최신순 목록엔 없음 → 엇갈림
const pc0 = publicCalls, lc0 = listCalls;
await page.click('.sheet-card button[data-act="run"]');
await page.waitForFunction(() => document.querySelector("#checkProg")?.textContent.startsWith("검사 완료"), null, { timeout: 15000 });
await page.screenshot({ path: `${OUT}/07-check.png`, fullPage: true });
check("보임 기록", cell(rv, "공개확인").startsWith("보임 ("), cell(rv, "공개확인"));
check("안 보임 기록", cell(rh, "공개확인").startsWith("안 보임 ("), cell(rh, "공개확인"));
check("엇갈림 기록", cell(rm, "공개확인").startsWith("엇갈림 ("), cell(rm, "공개확인"));
check("ID 조회는 키로 1번(50개 묶음)", publicCalls - pc0 === 1, String(publicCalls - pc0));
check("영상별 최신순 목록 조회", listCalls - lc0 === new Set(doneRows.map(vidOf)).size, String(listCalls - lc0));
check("문제 탭 기본 선택", (await page.getAttribute('#checkTabs .tab.active', "data-cf")) === "problem");
const probCards = await page.locator("#checkList .item").count();
check("문제 탭에 안 보임+엇갈림", probCards === 2, String(probCards));
check("카드 요약 표시", (await page.textContent(".sheet-card .meta")).includes(`${doneRows.length}개 중`), await page.textContent(".sheet-card .meta"));
// 다시 검사: 보이는 건 최신 시각으로, 한 번 안 보인 건 처음 시각 고정 (다시 조회도 안 함)
const firstHidden = cell(rh, "공개확인");
check("안 보임 = 최초 시각", /^안 보임 \(최초 \d\d\/\d\d \d\d:\d\d\)$/.test(firstHidden), firstHidden);
check("보임 = 최근 확인 시각", /^보임 \(최근 확인 /.test(cell(rv, "공개확인")), cell(rv, "공개확인"));
setCell(`x!${String.fromCharCode(65 + H().indexOf("공개확인"))}${rv}`, "보임 (최근 확인 01/01 00:00)");   // 예전 확인 시각으로 바꿔 둠
setCell(`x!${String.fromCharCode(65 + H().indexOf("공개확인"))}${rh}`, "안 보임 (최초 01/01 09:00)");
hiddenIds.clear(); listHidden.clear();         // 숨겼던 게 다시 보이는 상황이어도
const lcA = listCalls;
await page.click('.sheet-card button[data-act="run"]');
await page.waitForFunction(() => document.querySelector("#checkProg")?.textContent.startsWith("검사 완료"), null, { timeout: 15000 });
check("안 보인 시각 고정", cell(rh, "공개확인") === "안 보임 (최초 01/01 09:00)", cell(rh, "공개확인"));
check("보임은 최신 시각으로 갱신", cell(rv, "공개확인").startsWith("보임 (최근 확인 ") && !cell(rv, "공개확인").includes("01/01"), cell(rv, "공개확인"));
check("이력 쌓지 않음", !cell(rv, "공개확인").includes("→"), cell(rv, "공개확인"));
check("엇갈림 → 보임 최신화", cell(rm, "공개확인").startsWith("보임 (최근 확인"), cell(rm, "공개확인"));
const vidsLive = new Set(doneRows.filter((r) => r !== rh).map(vidOf));
check("이미 안 보인 댓글만 있는 영상은 목록 조회 안 함", listCalls - lcA === vidsLive.size, `${listCalls - lcA} vs ${vidsLive.size}`);
check("문제 탭 유지(안 보임 1)", (await page.getAttribute('#checkTabs .tab.active', "data-cf")) === "problem");
check("결과 카드에 고정 표시", (await page.textContent("#checkList")).includes("다시 조회 안 함"));
// 정밀 검사 끄면 목록 조회 안 함
await page.uncheck("#chkDeep");
const lc1 = listCalls;
await page.click('.sheet-card button[data-act="run"]');
await page.waitForFunction(() => document.querySelector("#checkProg")?.textContent.startsWith("검사 완료"), null, { timeout: 15000 });
check("최신순 끄면 ID 조회만", listCalls === lc1, String(listCalls - lc1));
await page.check("#chkDeep");
// 새로고침해도 모드·시트 목록 유지
await page.reload();
await page.waitForSelector(".sheet-card");
check("새로고침 후 공개 검사 모드 유지", await page.isVisible("#checkMode"));
await page.click('.mode[data-mode="upload"]');
await page.waitForSelector("#sheetCard");
check("업로드로 돌아오면 게시 바 보임", await page.isVisible(".runbar"));

// 9-2) PC 폴더 백업 (PC 브라우저의 폴더 권한 흉내)
await page.click("#btnSettings");
const hasFsApi = await page.evaluate(() => typeof window.showDirectoryPicker === "function");
check("폴더 API 없으면 백업 항목 숨김 (있으면 보임)", (await page.isVisible("#backupField")) === hasFsApi, String(hasFsApi));
await page.click("#btnSettingsSave");
await page.addInitScript(() => {
  window.__files = {}; window.__perm = "granted";
  window.showDirectoryPicker = async () => ({
    name: "확인할 작업물", kind: "directory",
    queryPermission: async () => window.__perm,
    requestPermission: async () => (window.__perm = "granted"),
    getFileHandle: async (name) => ({ createWritable: async () => { let buf = ""; return { write: async (t) => { buf += t; }, close: async () => { window.__files[name] = buf; } }; } }),
  });
});
await page.reload();
await page.click('.mode[data-mode="upload"]');
await page.waitForFunction(() => document.querySelector("#summary")?.textContent.includes("완료"), null, { timeout: 10000 });
await page.click("#btnSettings");
check("PC에선 백업 항목 보임", await page.isVisible("#backupField"));
await page.click("#btnPickFolder");
await page.waitForFunction(() => Object.keys(window.__files).length > 0, null, { timeout: 8000 });
const files = await page.evaluate(() => window.__files);
check("전체 + 채널별 CSV", ["댓글업로드기록_전체.csv", "댓글업로드기록_또이안이야.csv", "댓글업로드기록_yun sj.csv"].every((n) => n in files), Object.keys(files).join(", "));
check("CSV 내용(BOM+머리글+행)", files["댓글업로드기록_전체.csv"].startsWith("\uFEFF게시시각,채널ID") && files["댓글업로드기록_전체.csv"].split("\r\n").length - 2 === recordGrid.length - 1, String(files["댓글업로드기록_전체.csv"].split("\r\n").length));
check("채널별 파일엔 그 채널만", !files["댓글업로드기록_yun sj.csv"].includes(",UC_BRAND,"));
await page.screenshot({ path: `${OUT}/06c-backup.png` });
await page.click("#btnSettingsSave");
// 권한이 풀린 상태면 저장하지 않고 안내
await page.evaluate(() => { window.__files = {}; window.__perm = "prompt"; });
await page.click("#btnRefresh");
await page.waitForTimeout(1500);
check("권한 없으면 자동 저장 안 함", Object.keys(await page.evaluate(() => window.__files)).length === 0);
await page.click("#btnSettings");
check("권한 다시 허용 안내", (await page.textContent("#backupText")).includes("권한 다시 허용"), await page.textContent("#backupText"));
await page.click("#btnBackupNow");                 // 누르면 권한 요청 → 저장
await page.waitForFunction(() => Object.keys(window.__files).length > 0, null, { timeout: 8000 });
check("[지금 백업]으로 권한 허용 후 저장", true);
await page.click("#btnSettingsSave");

// 10) 다크 모드 스크린샷
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/08-dark.png` });

check("페이지 오류 없음", errors.length === 0, errors.join(" | "));
await browser.close();
for (const r of results) console.log(r[0], r[1], r[2] ? `(${r[2]})` : "");
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
