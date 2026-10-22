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
  assert.deepEqual(plan.add.map((a) => [a.name, a.index]), [["상태", 7], ["게시시각", 8], ["댓글링크", 9], ["게시채널", 10], ["오류", 11]]);
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
  assert.equal(L.planManagedColumns(h, c).add.length, 0);
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
