import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseBacklog,
  cleanText,
  parseCommits,
  latestScoreboard,
  escapeHtml,
  renderDashboardHtml,
  parseWatchIntervalMs
} from "./build-status-dashboard.mjs";

test("parseBacklog counts each marker and lists the actionable (non-done) items", () => {
  const md = [
    "- [done] 2026-07-16 commit=abc1234 :: shipped thing one",
    "- [done] :: shipped thing two",
    "- [open] prio=5 :: the next priority",
    "- [open] :: a ready slice",
    "- [open] kind=fix :: another ready slice",
    "- [decision] :: blocked on a decision",
    "- [rejected] :: a rejected direction — counted nowhere",
    "plain prose line — not an item",
    "## a heading"
  ].join("\n");
  const { counts, items } = parseBacklog(md);
  assert.equal(counts.done, 2);
  assert.equal(counts.next, 1);
  assert.equal(counts.ready, 2);
  assert.equal(counts.blocked, 1);
  // done items are counted but NOT listed (only actionable ones surface)
  assert.deepEqual(items.next, ["the next priority"]);
  assert.deepEqual(items.ready, ["a ready slice", "another ready slice"]);
  assert.deepEqual(items.blocked, ["blocked on a decision"]);
});

test("parseBacklog ignores prose and headings (no false items)", () => {
  const { counts } = parseBacklog("just some text\n### heading\n- a plain bullet without a marker");
  assert.deepEqual(counts, { done: 0, ready: 0, next: 0, blocked: 0 });
});

test("cleanText strips bold/code/links and truncates", () => {
  assert.equal(cleanText("**bold** and `code` and [link](http://x)"), "bold and code and link");
  assert.equal(cleanText("x".repeat(200)).length, 160);
  assert.ok(cleanText("x".repeat(200)).endsWith("…"));
});

test("parseCommits splits tab fields and classifies the conventional type", () => {
  const raw = ["abc123\t2 hours ago\tfeat(recall): add a thing", "def456\t1 day ago\tfix: a bug", "ghi789\t3 days ago\tplain subject no type"].join("\n");
  const rows = parseCommits(raw);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { hash: "abc123", when: "2 hours ago", subject: "feat(recall): add a thing", type: "feat" });
  assert.equal(rows[1].type, "fix");
  assert.equal(rows[2].type, "other");
});

test("parseCommits ignores blank lines", () => {
  assert.equal(parseCommits("abc\t1m\tfeat: x\n\n").length, 1);
});

test("latestScoreboard takes the last entry and flattens gates", () => {
  const board = [
    { at: "2026-01-01T00:00:00Z", gates: { lint: { status: "pass" } } },
    { at: "2026-06-27T12:00:00Z", gates: { lint: { status: "pass" }, testFiles: { status: "pass", value: 1158 } } }
  ];
  const { at, gates } = latestScoreboard(board);
  assert.equal(at, "2026-06-27T12:00:00Z");
  assert.deepEqual(gates.find((g) => g.name === "testFiles"), { name: "testFiles", status: "pass", value: 1158 });
});

test("latestScoreboard tolerates an empty/garbage scoreboard", () => {
  assert.deepEqual(latestScoreboard([]), { at: undefined, gates: [] });
  assert.deepEqual(latestScoreboard(null), { at: undefined, gates: [] });
});

test("escapeHtml neutralizes injection from a backlog/commit string", () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("parseWatchIntervalMs: absent → undefined, bare → 5s, explicit → that, garbage → 5s", () => {
  assert.equal(parseWatchIntervalMs(["node", "x.mjs"]), undefined);
  assert.equal(parseWatchIntervalMs(["--watch"]), 5000);
  assert.equal(parseWatchIntervalMs(["--watch", "10"]), 10000);
  assert.equal(parseWatchIntervalMs(["--watch", "abc"]), 5000); // never 0/NaN (would busy-loop)
  assert.equal(parseWatchIntervalMs(["--watch", "0"]), 5000);
});

test("renderDashboardHtml injects a meta-refresh ONLY when refreshSeconds is set (watch mode)", () => {
  const base = {
    project: "Muse", branch: "main", generatedAt: "now", inSync: true, gates: [], scoreboardAt: undefined,
    commits: [], backlog: { counts: { done: 0, ready: 0, next: 0, blocked: 0 }, items: { next: [], ready: [], blocked: [] } }
  };
  assert.ok(!renderDashboardHtml(base).includes("http-equiv=\"refresh\""), "one-shot has no auto-reload");
  const watched = renderDashboardHtml({ ...base, refreshSeconds: 7 });
  assert.ok(watched.includes('<meta http-equiv="refresh" content="7">'), "watch mode injects the meta-refresh");
});

test("renderDashboardHtml produces a self-contained doc and escapes data", () => {
  const html = renderDashboardHtml({
    project: "Muse", branch: "main", generatedAt: "2026-06-27", inSync: true,
    gates: [{ name: "lint", status: "pass" }],
    scoreboardAt: "2026-06-27",
    commits: [{ hash: "abc", when: "now", subject: "feat: <script>", type: "feat" }],
    backlog: { counts: { done: 5, ready: 2, next: 1, blocked: 1 }, items: { next: ["do <b>X</b>"], ready: ["y"], blocked: ["z"] } }
  });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("<style>") && html.includes("작업 상황판"));
  assert.ok(html.includes("&lt;script&gt;"), "commit subject must be escaped");
  assert.ok(!html.includes("<script>"), "no unescaped script tag leaks");
  assert.ok(html.includes("origin 동기화됨"));
});
