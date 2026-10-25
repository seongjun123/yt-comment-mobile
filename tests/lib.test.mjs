import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../lib.js";

test("extractVideoId", () => {
  assert.equal(L.extractVideoId("https://www.youtube.com/watch?v=HuaGOfzVBiU&t=171s"), "HuaGOfzVBiU");
  assert.equal(L.extractVideoId("youtu.be/_njE1rfRTU0?si=x"), "_njE1rfRTU0");
  assert.equal(L.extractVideoId("https://m.youtube.com/shorts/dpjYK2UuYAY"), "dpjYK2UuYAY");
  assert.equal(L.extractVideoId("dpjYK2UuYAY"), "dpjYK2UuYAY");
  assert.equal(L.extractVideoId("https://evilyoutube.com/watch?v=dpjYK2UuYAY"), null);
  assert.equal(L.extractVideoId(""), null);
  assert.equal(L.extractVideoId(null), null);
});

test("parseSheetUrl", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";
  assert.deepEqual(L.parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), { id, gid: 0 });
  assert.deepEqual(L.parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`), { id, gid: null });
  assert.deepEqual(L.parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=123456#gid=123456`), { id, gid: 123456 });
  assert.equal(L.parseSheetUrl("https://example.com"), null);
});

test("colLetter / quoteSheet", () => {
  assert.equal(L.colLetter(0), "A");
  assert.equal(L.colLetter(25), "Z");
  assert.equal(L.colLetter(26), "AA");
  assert.equal(L.colLetter(701), "ZZ");
  assert.equal(L.quoteSheet("유튜브관제탑_롱폼's"), "'유튜브관제탑_롱폼''s'");
});

const HEADER = ["채널명", "제목", "조회수", "구독자", "업로드 날짜", "영상 링크", "댓글"];
const row = (ch, title, vid, comment, ...rest) =>
  [ch, title, "100", "10", "2026-10-22", `https://www.youtube.com/watch?v=${vid}`, comment, ...rest];

test("findColumns: 관제탑 형식", () => {
  const rows = [row("아름약사", "T1", "dpjYK2UuYAY", "c1"), row("B", "T2", "HuaGOfzVBiU", "")];
  const c = L.findColumns(HEADER, rows);
  assert.equal(c.comment, 6);
  assert.equal(c.video, 5);
  assert.equal(c.title, 1);
  assert.equal(c.channel, 0);
  assert.equal(c.managed["상태"], -1);
  const plan = L.planManagedColumns(HEADER, c);
  assert.deepEqual(plan.add.map((a) => [a.name, a.index]), [["상태", 7], ["게시시각", 8], ["댓글링크", 9], ["게시채널", 10], ["오류", 11], ["공개확인", 12]]);
});

test("findColumns: '댓글 수' 열은 댓글 열이 아니다", () => {
  const c = L.findColumns(["제목", "댓글 수", "영상", "댓글"], [["t", "12", "https://youtu.be/dpjYK2UuYAY", "hi"]]);
  assert.equal(c.comment, 3);
  assert.equal(c.video, 2);
});

test("findColumns: 이미 관리 열이 있으면 그 위치 사용", () => {
  const h = [...HEADER, "상태", "게시시각", "댓글링크", "게시채널", "오류"];
  const c = L.findColumns(h, [row("a", "t", "dpjYK2UuYAY", "c", "게시 완료")]);
  assert.equal(c.managed["상태"], 7);
  assert.deepEqual(L.planManagedColumns(h, c).add.map((a) => a.name), ["공개확인"]);   // 1.1.0에서 추가된 열만
});

test("classifyRows", () => {
  const h = [...HEADER, "상태", "게시시각", "댓글링크", "게시채널", "오류"];
  const rows = [
    row("a", "t", "dpjYK2UuYAY", "좋아요"),                       // 2 target
    row("a", "t", "HuaGOfzVBiU", ""),                             // 3 empty
    row("a", "t", "_njE1rfRTU0", "완료됨", "게시 완료"),             // 4 done
    row("a", "t", "_njE1rfRTU0", "완료됨"),                        // 5 dup (4와 같은 조합)
    row("a", "t", "AAAAAAAAAAA", "재시도", "실패", "", "", "", "403"), // 6 fail
    row("a", "t", "BBBBBBBBBBB", "끊김", "게시 중"),                 // 7 orphan
    ["a", "t", "", "", "", "주소아님", "x"],                         // 8 invalid
    row("a", "t", "CCCCCCCCCCC", "건너뜀", "건너뜀"),                // 9 skip
    [],                                                            // 10 빈 행 (무시)
    row("a", "t", "dpjYK2UuYAY", "좋아요"),                         // 11 dup (2와 같은 조합)
  ];
  const c = L.findColumns(h, rows);
  const p = L.planManagedColumns(h, c).pos;
  const { items, counts } = L.classifyRows(rows, c, p);
  const kinds = Object.fromEntries(items.map((i) => [i.row, i.kind]));
  assert.deepEqual(kinds, { 2: "target", 3: "empty", 4: "done", 5: "dup", 6: "fail", 7: "orphan", 8: "invalid", 9: "skip", 11: "dup" });
  assert.equal(counts.target, 1);
  assert.equal(items.find((i) => i.row === 6).error, "403");
});

test("repeatedTexts", () => {
  const items = [{ kind: "target", text: "a" }, { kind: "fail", text: "a" }, { kind: "target", text: "b" }, { kind: "done", text: "b" }];
  assert.deepEqual(L.repeatedTexts(items), ["a"]);
});

test("quotaDayKey: 태평양 자정 기준", () => {
  // 2026-10-23 06:59 UTC = 10-22 23:59 PDT
  assert.equal(L.quotaDayKey(new Date("2026-10-23T06:59:00Z")), "2026-10-22");
  assert.equal(L.quotaDayKey(new Date("2026-10-23T07:01:00Z")), "2026-10-23");
});

test("kstStamp", () => {
  assert.equal(L.kstStamp(new Date("2026-10-22T15:41:05Z")), "2026-10-23 00:41:05");
});

test("randomDelay 범위", () => {
  assert.equal(L.randomDelay(30, 90, () => 0), 30);
  assert.equal(L.randomDelay(30, 90, () => 1), 90);
  assert.equal(L.randomDelay(90, 30, () => 0), 30);
  assert.deepEqual(L.DEFAULT_DELAY, { lo: 60, hi: 120 });
  // 10% 확률 긴 휴식: 첫 난수 < 0.1 이면 180~240초
  const seq = (...xs) => { let i = 0; return () => xs[i++]; };
  assert.equal(L.nextDelay(60, 120, true, seq(0.05, 0)), 180);
  assert.equal(L.nextDelay(60, 120, true, seq(0.09, 1)), 240);
  assert.equal(L.nextDelay(60, 120, true, seq(0.1, 0)), 60);
  assert.equal(L.nextDelay(60, 120, true, seq(0.5, 1)), 120);
  assert.equal(L.nextDelay(0, 0, false, seq(0.01, 0.5)), 0);   // 끄면 긴 휴식 없음
  let long = 0, n = 20000;
  for (let i = 0; i < n; i++) { const d = L.nextDelay(60, 120); assert.ok((d >= 60 && d <= 120) || (d >= 180 && d <= 240)); if (d >= 180) long++; }
  assert.ok(long / n > 0.08 && long / n < 0.12, String(long / n));
});

test("errorReason", () => {
  const b = (reason) => JSON.stringify({ error: { errors: [{ reason }], message: "m" } });
  assert.equal(L.errorReason(403, b("quotaExceeded")).code, "quota");
  assert.equal(L.errorReason(403, b("commentsDisabled")).code, "disabled");
  assert.equal(L.errorReason(401, "").code, "auth");
  assert.equal(L.errorReason(404, b("videoNotFound")).code, "notfound");
  assert.equal(L.errorReason(403, b("forbidden")).code, "forbidden");
  assert.equal(L.errorReason(500, "oops").code, "other");
});

test("공개 검사", () => {
  const posted = "2026-10-23 01:00:00";            // KST
  assert.equal(new Date(L.parseKst(posted)).toISOString(), "2026-10-22T16:00:00.000Z");
  assert.equal(L.commentIdFromLink("https://www.youtube.com/watch?v=x&lc=UgxABC123"), "UgxABC123");
  assert.equal(L.commentIdFromLink(""), null);

  const header = ["채널명", "제목", "영상 링크", "댓글", "상태", "게시시각", "댓글링크", "게시채널", "오류"];
  const rows = [
    ["A", "t1", "https://youtu.be/dpjYK2UuYAY", "c1", "게시 완료", posted, "https://www.youtube.com/watch?v=dpjYK2UuYAY&lc=Ugx1", "yun sj", ""],
    ["B", "t2", "https://youtu.be/HuaGOfzVBiU", "c2", "실패", "", "", "", "꺼짐"],
    ["C", "t3", "https://youtu.be/_njE1rfRTU0", "c3", "게시 완료", posted, "https://www.youtube.com/watch?v=_njE1rfRTU0&lc=Ugx3", "또이안이야", ""],
  ];
  const r = L.linkRows(header, rows);
  assert.equal(r.linkCol, 6);
  assert.equal(r.visCol, -1);                        // 공개확인 열 없음 → 검사 때 추가
  assert.deepEqual(r.rows.map((x) => [x.row, x.cid, x.vid, x.text, x.postedBy]),
    [[2, "Ugx1", "dpjYK2UuYAY", "c1", "yun sj"], [4, "Ugx3", "_njE1rfRTU0", "c3", "또이안이야"]]);
  assert.equal(L.linkRows(["채널명", "영상 링크"], [["a", "https://youtu.be/dpjYK2UuYAY"]]), null);

  assert.equal(L.visVerdict(true, true), "visible");
  assert.equal(L.visVerdict(false, false), "hidden");
  assert.equal(L.visVerdict(true, false), "mixed");
  assert.equal(L.visVerdict(false, true), "mixed");
  assert.equal(L.visVerdict(true, null), "visible");
  assert.equal(L.visVerdict(false, null), "hidden");
  assert.equal(L.visVerdict(false, null, true), "gone");

  const t13 = Date.parse("2026-10-25T13:00:00+09:00"), t14 = Date.parse("2026-10-25T14:00:00+09:00");
  assert.equal(L.nextVisibility("", "visible", t13), "보임 (최근 확인 10/25 13:00)");
  assert.equal(L.nextVisibility("보임 (최근 확인 10/25 13:00)", "visible", t14), "보임 (최근 확인 10/25 14:00)");   // 최신화
  assert.equal(L.nextVisibility("보임 (최근 확인 10/25 13:00)", "hidden", t14), "안 보임 (최초 10/25 14:00)");
  assert.equal(L.nextVisibility("", "hidden", t13), "안 보임 (최초 10/25 13:00)");
  // 처음 안 보인 시각은 고정: 14시에 다시 검사해도 13시 그대로 (다시 보이더라도)
  assert.equal(L.nextVisibility("안 보임 (최초 10/25 13:00)", "hidden", t14), "안 보임 (최초 10/25 13:00)");
  assert.equal(L.nextVisibility("안 보임 (최초 10/25 13:00)", "visible", t14), "안 보임 (최초 10/25 13:00)");
  assert.equal(L.nextVisibility("엇갈림 (최근 확인 10/25 13:00)", "mixed", t14), "엇갈림 (최근 확인 10/25 14:00)");
  // 예전 이력 형식 → 처음 안 보인 시각을 뽑아 새 형식으로
  assert.equal(L.nextVisibility("보임 (10/23 02:43) → 안 보임 (10/24 09:10) → 보임 (10/24 10:00)", "visible", t14), "안 보임 (최초 10/24 09:10)");
  assert.equal(L.nextVisibility("1차 보임 (10/23 01:05) → 2차 안 보임 (10/24 01:10)", "hidden", t14), "안 보임 (최초 10/24 01:10)");
  assert.equal(L.nextVisibility("1차 보임 (10/23 01:05)", "visible", t14), "보임 (최근 확인 10/25 14:00)");
  assert.deepEqual(L.parseVisibility("안 보임 (최초 10/25 13:00)"), { state: "hidden", hiddenAt: "10/25 13:00" });
  assert.equal(L.visibilityState("보임 (최근 확인 x)"), "visible");
  assert.equal(L.visibilityState("엇갈림 (최근 확인 x)"), "mixed");
  assert.equal(L.visibilityState("영상/댓글창 없음 (최근 확인 x)"), "gone");
  assert.equal(L.visibilityState("1차 보임 (x) → 2차 안 보임 (y)"), "hidden");
  assert.equal(L.visibilityState(""), "");
});

test("업로드 기록 · 채널별 중복", () => {
  const values = [
    L.RECORD_HEADER,
    L.recordRow({ at: "2026-10-23 01:00:00", channelId: "UC_BRAND", channelTitle: "또이안이야", vid: "dpjYK2UuYAY", link: "https://www.youtube.com/watch?v=dpjYK2UuYAY&lc=a" }),
    // 사람이 직접 적은 행: 채널ID·영상ID 없이 채널명 + 영상 주소만
    ["", "", "또이안이야", "", "", "", "", "https://www.youtube.com/watch?v=HuaGOfzVBiU", ""],
    ["", "", "", "", "", "", "", "", ""],
  ];
  const ix = L.recordIndex(values);
  assert.equal(ix.count, 2);
  const brand = { id: "UC_BRAND", title: "또이안이야", handle: "@또이안이야" };
  const me = { id: "UC_ME", title: "yun sj" };
  assert.ok(ix.has(brand, "dpjYK2UuYAY"));
  assert.ok(ix.has(brand, "HuaGOfzVBiU"));          // 채널명으로 매칭
  assert.equal(ix.has(me, "dpjYK2UuYAY"), null);     // 다른 채널은 한 번 가능
  assert.equal(ix.has(brand, "_njE1rfRTU0"), null);
  assert.ok(ix.has({ id: "", title: "", handle: "@또이안이야" }, "dpjYK2UuYAY"));
  ix.add({ channelId: "UC_ME", channelTitle: "yun sj", vid: "dpjYK2UuYAY" });
  assert.ok(ix.has(me, "dpjYK2UuYAY"));

  const items = [
    { kind: "done", vid: "_njE1rfRTU0", postedBy: "또이안이야", postedAt: "t", text: "x", link: "l" },
    { kind: "done", vid: "_njE1rfRTU0", postedBy: "또이안이야", postedAt: "t", text: "y", link: "l2" },   // 같은 영상 두 번 → 1번만
    { kind: "done", vid: "dpjYK2UuYAY", postedBy: "또이안이야" },          // 이미 기록됨
    { kind: "target", vid: "AAAAAAAAAAA", postedBy: "" },
    { kind: "done", vid: "BBBBBBBBBBB", postedBy: "모르는채널" },
  ];
  const miss = L.missingRecordRows(items, ix, { UC_BRAND: { title: "또이안이야" } }, "시트A");
  assert.deepEqual(miss.map((m) => [m.vid, m.channelId, m.channelTitle, m.sheet]),
    [["_njE1rfRTU0", "UC_BRAND", "또이안이야", "시트A"], ["BBBBBBBBBBB", "", "모르는채널", "시트A"]]);

  assert.equal(L.toCsv([["a", "b,c"], ['q"q', "줄\n바꿈"]]), '﻿a,"b,c"\r\n"q""q","줄\n바꿈"\r\n');
  assert.equal(L.safeFileName('a/b:c*?'), "a_b_c__");
  const files = L.backupFiles(values);
  assert.deepEqual(Object.keys(files).sort(), ["댓글업로드기록_또이안이야.csv", "댓글업로드기록_전체.csv"]);
  assert.ok(files["댓글업로드기록_전체.csv"].startsWith("﻿게시시각,채널ID"));
});
