/**
 * LIVE end-to-end battery for deterministic TOOL-ARG GROUNDING on local qwen —
 * the capstone for the fabrication=0 edge at the actuator boundary. The 8B
 * fabricates a calendar `location` the user never said and it gets PERSISTED;
 * the runtime now drops a groundedArg whose value isn't in the user's utterance.
 * This drives the REAL assembly (agentRuntime → muse.calendar.add → local
 * file provider) and inspects the PERSISTED event — proving the drop happens
 * end-to-end with the real model, not just in a unit test.
 *
 *   node apps/cli/scripts/verify-tool-arg-grounding.mjs   (qwen3:8b)
 *
 * Exit 0 if it passes (or Ollama unreachable — a skip is not a pass), 1
 * otherwise. LOCAL OLLAMA ONLY. TZ pinned so local time resolves.
 */
process.env.TZ = "Asia/Seoul";

import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-tag-"));
process.env.MUSE_DEFAULT_MODEL = model;

const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
try {
  const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error("not ok");
} catch {
  console.log(`verify-tool-arg-grounding skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const calendarFile = path.join(process.env.HOME, ".muse", "calendar.json");
function readEvents() {
  try {
    return JSON.parse(readFileSync(calendarFile, "utf8")).events ?? [];
  } catch {
    return [];
  }
}

const asm = createMuseRuntimeAssembly();
if (!asm.agentRuntime) { console.error("no agentRuntime"); process.exit(2); }
const SYSTEM = "You are Muse, the user's personal assistant. When the user asks you to schedule something, call the muse.calendar.add tool with fully-populated arguments and actually create it.";

async function addViaAgent(prompt) {
  const before = readEvents().length;
  for await (const _ev of asm.agentRuntime.stream({
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    metadata: { localMode: true, userId: "tag" },
    model,
    // allow the calendar write so it persists; deny nothing else matters here
    toolApprovalGate: async () => ({ allowed: true })
  })) { /* drain */ }
  return readEvents().slice(before); // events created by THIS run
}

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"} — ${name}\n   ${got}`); if (!ok) failures += 1; };

// Case 1 (the defect): no place mentioned → any location the model invents must be dropped.
const created1 = await addViaAgent("내일 오후 3시에 회의 잡아줘");
const ev1 = created1[created1.length - 1];
check(
  "no-location prompt: created event has NO fabricated location",
  ev1 !== undefined && (ev1.location === undefined || ev1.location === ""),
  ev1 ? `event title=${JSON.stringify(ev1.title)} location=${JSON.stringify(ev1.location)}` : "NO EVENT CREATED (model did not call calendar.add)"
);

// Case 2 (no false drop): the user states the place → it must survive.
const created2 = await addViaAgent("내일 오후 5시에 강남역에서 회의 잡아줘");
const ev2 = created2[created2.length - 1];
check(
  "with-location prompt: the stated location (강남역) is KEPT",
  ev2 !== undefined && typeof ev2.location === "string" && ev2.location.includes("강남"),
  ev2 ? `event title=${JSON.stringify(ev2.title)} location=${JSON.stringify(ev2.location)}` : "NO EVENT CREATED"
);

console.log(failures === 0 ? `\nALL PASS (2) on ${model}` : `\n${failures}/2 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
