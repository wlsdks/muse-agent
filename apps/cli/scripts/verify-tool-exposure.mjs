/**
 * Deterministic tool-EXPOSURE regression guard (no model, ~3s). For each
 * domain×intent×language prompt, assert the matching tool is exposed after the
 * real pipeline (planForContext relevance + mutation gate → DefaultToolFilter
 * domain gate). Locks in the eval-surfaced keyword/vocab fixes (slices 45-50)
 * so they can't regress. Exposure only — selection by the model is the live
 * battery's job (verify-tool-battery.mjs).
 *
 *   node apps/cli/scripts/verify-tool-exposure.mjs
 *
 * Exit 0 if every prompt reaches its tool, 1 otherwise.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-tx-"));
process.env.MUSE_DEFAULT_MODEL = "ollama/gemma4:12b";
process.env.MUSE_HOMEASSISTANT_URL = "http://x";
process.env.MUSE_HOMEASSISTANT_TOKEN = "t";

const { createMuseRuntimeAssembly } = await import("@muse/autoconfigure");
const { createWorkspaceToolRoutingPlan } = await import("@muse/tools");
const { DefaultToolFilter } = await import("@muse/agent-core");

const tools = createMuseRuntimeAssembly().toolRegistry.list();
const tf = new DefaultToolFilter();
const exposed = (p) => tf.filter(createWorkspaceToolRoutingPlan(tools, { prompt: p, localMode: true }).tools, { userMessage: p }).map((t) => t.definition.name);

const cases = [
  ["show my notes", "muse.notes.list"], ["내 노트 보여줘", "muse.notes.list"],
  ["search my notes for ramen", "muse.notes.search"], ["노트에서 라멘 검색", "muse.notes.search"],
  ["save a note: buy milk", "muse.notes.save"], ["메모 저장: 우유", "muse.notes.save"],
  ["what's on my calendar today", "muse.calendar.list"], ["오늘 일정 뭐 있어", "muse.calendar.list"],
  ["add a meeting friday 3pm", "muse.calendar.add"], ["금요일 3시 회의 추가", "muse.calendar.add"],
  ["what reminders do I have", "muse.reminders"], ["내 리마인더 목록", "muse.reminders"],
  ["remind me to call mom", "muse.reminders.add"], ["엄마한테 전화 리마인드", "muse.reminders.add"],
  ["show my tasks", "muse.tasks.list"], ["할 일 목록", "muse.tasks.list"],
  ["add a task buy milk", "muse.tasks.add"], ["할 일 추가: 우유 사기", "muse.tasks.add"],
  ["mark the report task done", "muse.tasks.complete"],
  ["오늘 마감인 일", "muse.tasks.list"], ["what's due today", "muse.tasks.list"],
  ["what did we discuss last session", "muse.episode"], ["지난 세션 뭐였지", "muse.episode"],
  ["check my inbox", "muse.messaging.inbox"], ["받은 메일 확인", "muse.messaging.inbox"],
  ["summarize https://example.com/post", "muse.web.read"], ["이 기사 읽어줘 https://example.com/article", "muse.web.read"],
  ["what does https://example.com/page say", "muse.web.read"]
];

// Over-exposure negatives: exposure that pulls in an UNRELATED domain's tools is
// as broken as under-exposure (it widens the model's wrong-selection surface,
// tool-calling.md rule 1). Each prompt asserts a genuinely-unrelated domain's
// tools stay OUT — a plan that dumps the whole registry would fail here.
const negativeCases = [
  ["show my notes", ["muse.calendar", "home_", "muse.web"]],
  ["what's on my calendar today", ["muse.notes.save", "home_"]],
  ["turn on the living room light", ["muse.notes", "muse.calendar"]],
  ["save a note: buy milk", ["home_", "muse.calendar", "muse.web"]]
];

let fail = 0;
for (const [p, want] of cases) {
  const ok = exposed(p).some((n) => n.startsWith(want));
  if (!ok) { fail += 1; console.log(`FAIL — "${p}" → ${want} NOT exposed`); }
}
for (const [p, forbidden] of negativeCases) {
  const names = exposed(p);
  const leaked = forbidden.filter((prefix) => names.some((n) => n.startsWith(prefix)));
  if (leaked.length > 0) { fail += 1; console.log(`FAIL — "${p}" over-exposed unrelated tools: ${leaked.join(", ")} (got ${names.join(", ")})`); }
}
const total = cases.length + negativeCases.length;
console.log(fail === 0 ? `\nALL PASS (${total}) — every prompt reaches its tool AND unrelated domains stay out` : `\n${fail}/${total} FAILED`);
process.exit(fail === 0 ? 0 : 1);
