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
};
const posted = [];          // {by, vid, text, id}

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
    if (p.get("prompt") === "none" && silentFails) {
      return route.fulfill({ status: 302, headers: { location: `${redirect}#error=interaction_required&state=${state}` } });
    }
    const isSheet = !p.get("scope").includes("youtube");
    const key = isSheet ? "sheet" : (p.get("prompt") === "none" ? (tokenOwner.lastChannelKey || pick) : pick);
    const tok = `${accounts[key].token}-${++tokenSeq}`;
    tokenOwner[tok] = key;
    if (!isSheet) tokenOwner.lastChannelKey = key;
    const frag = new URLSearchParams({ access_token: tok, expires_in: "3599", token_type: "Bearer", scope: p.get("scope").replace("openid email", "openid https://www.googleapis.com/auth/userinfo.email"), state });
    route.fulfill({ status: 302, headers: { location: `${redirect}#${frag}` } });
  });
  await page.route("https://openidconnect.googleapis.com/**", (route) => {
    const k = who(route.request());
    if (!k) return json(route, 401, {});
    json(route, 200, { email: accounts[k].email || undefined });
  });
  await page.route("https://www.googleapis.com/youtube/v3/**", (route) => {
    const req = route.request(), u = new URL(req.url()), k = who(req);
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
  await page.route("https://sheets.googleapis.com/**", (route) => {
    const req = route.request(), u = new URL(req.url()), k = who(req);
    if (!k) return json(route, 401, { error: { message: "auth" } });
    if (k === "brand") return json(route, 403, { error: { status: "PERMISSION_DENIED", message: "The caller does not have permission" } });
    const path = decodeURIComponent(u.pathname);
    if (path.endsWith(`/spreadsheets/${SHEET_ID}`)) {
      return json(route, 200, { properties: { title: "관제탑_롱폼" }, sheets: [{ properties: { sheetId: 0, title: "시트1", index: 0, gridProperties: { columnCount: colCount } } }] });
    }
    if (path.includes("/values/") && req.method() === "GET") return json(route, 200, { values: grid.map((r) => [...r]) });
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
await page.fill("#inpLo", "0"); await page.fill("#inpHi", "0");
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
check("관리 열 추가", H().slice(7).join(",") === "상태,게시시각,댓글링크,게시채널,오류", H().join(","));
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

// 8) 자동 갱신 실패 → 배너 → 수동 로그인 → 이어서 게시
grid.push(mk("B", "무인도", "HuaGOfzVBiU", "수동 갱신 테스트"));
await page.evaluate(() => {
  const ch = JSON.parse(localStorage.getItem("ytm.channels"));
  const cur = JSON.parse(localStorage.getItem("ytm.current"));
  ch[cur].exp = Date.now() + 2 * 60 * 1000;
  localStorage.setItem("ytm.channels", JSON.stringify(ch));
});
await page.reload();
await page.waitForSelector(".item");
silentFails = true;
const n1 = posted.length;
await page.click("#btnStart");
await page.waitForSelector("#dlgConfirm[open]");
await page.click("#dlgOk");
await page.waitForSelector("#authBanner:not(.hidden)", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/06-relogin-banner.png` });
check("자동 갱신 실패 시 배너", true);
silentFails = false;
await page.click("#btnRelogin");
await page.waitForFunction(() => document.querySelector("#dlgTitle")?.textContent === "결과" && document.querySelector("#dlgConfirm")?.open, null, { timeout: 20000 });
check("수동 로그인 후 이어서 게시", posted.length === n1 + 1 && posted.at(-1).text === "수동 갱신 테스트", String(posted.length - n1));
await page.click("#dlgOk");

// 9) 다크 모드 스크린샷
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/07-dark.png` });

check("페이지 오류 없음", errors.length === 0, errors.join(" | "));
await browser.close();
for (const r of results) console.log(r[0], r[1], r[2] ? `(${r[2]})` : "");
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
