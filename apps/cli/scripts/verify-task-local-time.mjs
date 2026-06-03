/**
 * FAST live battery for TASK LOCAL-TIME CONFIRMATION on LOCAL qwen — the
 * sibling of verify-reminder-local-time.mjs for the OTHER write actuator.
 *
 * The bug (found by probe): `muse ask --with-tools "add a task to review the
 * deck due tomorrow at 3pm"` STORED the task correctly (3pm local) but the
 * model CONFIRMED "Due Date: June 5, 2026 at 6:00 AM" — it read the raw UTC ISO
 * hour ("…T06:00:00Z" = 3pm KST) and parroted "6:00 AM". The fix enriches the
 * model-facing `muse.tasks.*` results with a `dueAtLocal` field + a
 * description anchor. Must be live-verified: the code only produces the field —
 * whether the local model ECHOES it is the real test.
 *
 *   node apps/cli/scripts/verify-task-local-time.mjs   (qwen3:8b)
 *
 * Exit 0 if it passes (or Ollama unreachable — a skip is not a pass), 1
 * otherwise. LOCAL OLLAMA QWEN ONLY. TZ pinned to Asia/Seoul so local ≠ UTC.
 */
process.env.TZ = "Asia/Seoul";

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { createTasksMcpServer } from "@muse/mcp";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-tasklocal-"));
process.env.MUSE_DEFAULT_MODEL = model;

const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
try {
  const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error("not ok");
} catch {
  console.log(`verify-task-local-time skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

// 1) Drive the REAL add tool — the shipped code path that builds the result.
const file = path.join(process.env.HOME, "tasks.json");
const server = createTasksMcpServer({ file });
const addTool = server.tools.find((t) => t.name === "add");
const result = await addTool.execute({ title: "Review the deck", dueAt: "tomorrow at 3pm" });
const task = result.task ?? {};
const isoUtc = String(task.dueAt ?? "");
const local = String(task.dueAtLocal ?? "");

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"} — ${name}\n   ${got}`); if (!ok) failures += 1; };

// 2) Deterministic: the result carries a LOCAL 3:00 PM while the raw ISO is the UTC 06:00 hour.
check(
  "add result carries dueAtLocal = local 3:00 PM (raw dueAt is the UTC 06:00 hour)",
  /3:00\s*PM/iu.test(local) && /T06:00/u.test(isoUtc),
  `dueAtLocal=${JSON.stringify(local)}  dueAt=${JSON.stringify(isoUtc)}`
);

// 3) LIVE: given the REAL tool description (the anchor) + the tool result, does
//    the local model CONFIRM with the local 3 PM, not the UTC 6 AM?
const modelProvider = createMuseRuntimeAssembly().modelProvider;
const system = `You are Muse, a personal assistant. You just called the \`muse.tasks.add\` tool. Here is that tool's documentation:\n\n${addTool.description}\n\nWrite ONE short sentence confirming the task to the user, based on the tool result below. State the due time.`;
const user = `Tool result:\n${JSON.stringify(result)}`;
const resp = await modelProvider.generate({ maxOutputTokens: 160, messages: [{ content: system, role: "system" }, { content: user, role: "user" }], model, temperature: 0 });
const out = (resp.output ?? "").toLowerCase();

const saysLocal = /3:00\s*pm|3\s*pm|3pm|3 in the afternoon|15:00/u.test(out);
const saysUtcHour = /6:00\s*am|6\s*am|6am|t06:00/u.test(out);
check(
  "model confirms the task with the LOCAL 3 PM, not the UTC 6 AM",
  saysLocal && !saysUtcHour,
  out.slice(0, 200)
);

console.log(failures === 0 ? `\nALL PASS (2) on ${model}` : `\n${failures}/2 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
