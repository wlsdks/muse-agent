/**
 * LIVE end-to-end battery for deterministic TOOL-ARG GROUNDING on local qwen —
 * the capstone for the fabrication=0 edge at the actuator boundary. The 8B
 * fabricates a calendar `location` the user never said and it gets PERSISTED;
 * the runtime now drops a groundedArg whose value isn't in the user's utterance.
 * This drives the REAL assembly (agentRuntime → muse.calendar.add → local
 * file provider) and inspects the PERSISTED event — proving the drop happens
 * end-to-end with the real model, not just in a unit test.
 *
 *   node apps/cli/scripts/verify-tool-arg-grounding.mjs   (pass^3 by default)
 *   MUSE_EVAL_REPEAT=5 node apps/cli/scripts/verify-tool-arg-grounding.mjs
 *
 * Exit 0 if it passes (or Ollama unreachable — a skip is not a pass), 1
 * otherwise. LOCAL OLLAMA ONLY. TZ pinned so local time resolves.
 */
process.env.TZ = "Asia/Seoul";

import { readFileSync } from "node:fs";

import { allowEvalToolCall, createEvalToolExposureAuthority } from "../../../scripts/lib/eval-tool-authority.mjs";
import { createEvalTrialEnvironment } from "../../../scripts/lib/eval-trial-environment.mjs";
import { completionLine, skipLine } from "../../../scripts/eval-skip.mjs";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
const parsedRepeat = Number(process.env.MUSE_EVAL_REPEAT ?? "3");
const repeat = Number.isFinite(parsedRepeat) ? Math.max(1, Math.trunc(parsedRepeat)) : 3;

const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
try {
  const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error("not ok");
} catch {
  console.log(`verify-tool-arg-grounding skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  console.log(skipLine("ollama-unreachable", "local provider unavailable"));
  console.log(completionLine({ status: "unverified", requested: repeat, executed: 0, reason: "ollama-unreachable" }));
  process.exit(0);
}

const environment = await createEvalTrialEnvironment({
  overrides: {
    MUSE_CALENDAR_PROVIDERS: "local",
    MUSE_DEFAULT_MODEL: model,
    OLLAMA_BASE_URL: baseUrl
  },
  prefix: "muse-tag-"
});
const calendarFile = environment.env.MUSE_CALENDAR_FILE;
function readEvents() {
  try {
    return JSON.parse(readFileSync(calendarFile, "utf8")).events ?? [];
  } catch {
    return [];
  }
}

try {
// Import only AFTER HOME and every inherited store override points at the
// disposable trial. Modules resolving process-level defaults cannot observe
// or rewrite the owner's state.
const { createMuseRuntimeAssembly } = await import("@muse/autoconfigure");
const asm = createMuseRuntimeAssembly({ env: environment.env });
if (!asm.agentRuntime) {
  console.error("no agentRuntime");
  process.exitCode = 2;
} else {
const SYSTEM = "You are Muse, the user's personal assistant. When the user asks you to schedule something, call the muse.calendar.add tool with fully-populated arguments and actually create it.";

async function addViaAgent(prompt, runId) {
  const before = readEvents().length;
  for await (const _ev of asm.agentRuntime.stream({
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    metadata: {
      userId: "tag"
    },
    model,
    runId,
    // allow the calendar write so it persists; deny nothing else matters here
    toolApprovalGate: allowEvalToolCall,
    toolExposureAuthority: createEvalToolExposureAuthority("tool-arg-grounding")
  })) { /* drain */ }
  return readEvents().slice(before); // events created by THIS run
}

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"} — ${name}\n   ${got}`); if (!ok) failures += 1; };

function tomorrowAt(hour) {
  const expected = new Date();
  expected.setDate(expected.getDate() + 1);
  expected.setHours(hour, 0, 0, 0);
  return expected;
}

function localDay(value) {
  return [value.getFullYear(), value.getMonth(), value.getDate()].join("-");
}

function terminalProblems(created, expectedStart, expectedLocation) {
  const problems = [];
  if (created.length !== 1) problems.push(`created=${created.length}, expected exactly 1`);
  const event = created.length === 1 ? created[0] : undefined;
  if (!event) return problems;
  const startsAt = new Date(event.startsAt);
  const endsAt = new Date(event.endsAt);
  if (Number.isNaN(startsAt.getTime())) problems.push(`invalid startsAt=${JSON.stringify(event.startsAt)}`);
  if (Number.isNaN(endsAt.getTime())) problems.push(`invalid endsAt=${JSON.stringify(event.endsAt)}`);
  if (!Number.isNaN(startsAt.getTime())) {
    if (localDay(startsAt) !== localDay(expectedStart)) problems.push(`local day=${localDay(startsAt)}, expected ${localDay(expectedStart)}`);
    if (startsAt.getHours() !== expectedStart.getHours() || startsAt.getMinutes() !== 0) {
      problems.push(`local time=${startsAt.getHours()}:${startsAt.getMinutes()}, expected ${expectedStart.getHours()}:0`);
    }
  }
  if (!Number.isNaN(startsAt.getTime()) && !Number.isNaN(endsAt.getTime()) && endsAt.getTime() - startsAt.getTime() !== 60 * 60_000) {
    problems.push(`durationMs=${endsAt.getTime() - startsAt.getTime()}, expected 3600000`);
  }
  if (expectedLocation === undefined) {
    if (event.location !== undefined && event.location !== "") problems.push(`fabricated location=${JSON.stringify(event.location)}`);
  } else if (typeof event.location !== "string" || !event.location.includes(expectedLocation)) {
    problems.push(`location=${JSON.stringify(event.location)}, expected to keep ${JSON.stringify(expectedLocation)}`);
  }
  return problems;
}

for (let round = 1; round <= repeat; round += 1) {
  // Case 1 (the defect): no place mentioned → any location the model invents must be dropped.
  const expectedNoLocation = tomorrowAt(15);
  const created1 = await addViaAgent("내일 오후 3시에 회의 잡아줘", `tool-arg-grounding-${round}-no-location`);
  const problems1 = terminalProblems(created1, expectedNoLocation, undefined);
  check(
    `pass ${round}/${repeat} no-location terminal state`,
    problems1.length === 0,
    problems1.length === 0 ? JSON.stringify(created1[0]) : problems1.join("; ")
  );

  // Case 2 (no false drop): the user states the place → it must survive.
  const expectedWithLocation = tomorrowAt(17);
  const created2 = await addViaAgent("내일 오후 5시에 강남역에서 회의 잡아줘", `tool-arg-grounding-${round}-with-location`);
  const problems2 = terminalProblems(created2, expectedWithLocation, "강남역");
  check(
    `pass ${round}/${repeat} stated-location terminal state`,
    problems2.length === 0,
    problems2.length === 0 ? JSON.stringify(created2[0]) : problems2.join("; ")
  );
}

console.log(failures === 0 ? `\nALL PASS (${2 * repeat}) on ${model}` : `\n${failures}/${2 * repeat} FAILED on ${model}`);
console.log(completionLine({
  status: failures === 0 ? "passed" : "failed",
  requested: repeat,
  executed: repeat,
  ...(failures === 0 ? {} : { reason: "terminal-state-assertion-failed" })
}));
process.exitCode = failures === 0 ? 0 : 1;
}
} finally {
  await environment.dispose();
}
