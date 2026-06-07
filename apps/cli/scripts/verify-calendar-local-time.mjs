/**
 * FAST live battery for CALENDAR LOCAL-TIME CONFIRMATION on LOCAL qwen — the
 * third sibling of verify-reminder-local-time.mjs / verify-task-local-time.mjs,
 * for the calendar write actuator.
 *
 * The bug (found by probe): `muse ask --with-tools "add a dentist appointment to
 * my calendar for tomorrow at 3pm"` STORED the event correctly (3pm local) but the
 * model CONFIRMED "Start Time: 2026-06-05T06:00:00.000Z" — it echoed the raw UTC
 * ISO timestamp (even uglier than the reminder/task case). The fix enriches the
 * model-facing `muse.calendar.*` results with `startsAtLocal` / `endsAtLocal` +
 * an `add` description anchor. Must be live-verified: the code only produces the
 * field — whether the local model ECHOES it is the real test.
 *
 *   node apps/cli/scripts/verify-calendar-local-time.mjs   (qwen3:8b)
 *
 * Exit 0 if it passes (or Ollama unreachable — a skip is not a pass), 1
 * otherwise. LOCAL OLLAMA ONLY. TZ pinned to Asia/Seoul so local ≠ UTC.
 */
process.env.TZ = "Asia/Seoul";

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { CalendarProviderRegistry, LocalCalendarProvider } from "@muse/calendar";
import { createCalendarMcpServer } from "@muse/mcp";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-callocal-"));
process.env.MUSE_DEFAULT_MODEL = model;

const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
try {
  const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error("not ok");
} catch {
  console.log(`verify-calendar-local-time skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

// 1) Drive the REAL add tool over a REAL local calendar — the shipped code path.
const file = path.join(process.env.HOME, "calendar.json");
const registry = new CalendarProviderRegistry([new LocalCalendarProvider({ file })]);
const server = createCalendarMcpServer({ registry });
const addTool = server.tools.find((t) => t.name === "add");
const result = await addTool.execute({ title: "Dentist appointment", startsAtIso: "tomorrow at 3pm" });
const event = result.event ?? {};
const isoUtc = String(event.startsAtIso ?? "");
const local = String(event.startsAtLocal ?? "");

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"} — ${name}\n   ${got}`); if (!ok) failures += 1; };

// 2) Deterministic: the result carries a LOCAL 3:00 PM while the raw ISO is the UTC 06:00 hour.
check(
  "add result carries startsAtLocal = local 3:00 PM (raw startsAtIso is the UTC 06:00 hour)",
  /3:00\s*PM/iu.test(local) && /T06:00/u.test(isoUtc),
  `startsAtLocal=${JSON.stringify(local)}  startsAtIso=${JSON.stringify(isoUtc)}`
);

// 3) LIVE: given the REAL tool description (the anchor) + the tool result, does
//    the local model CONFIRM with the local 3 PM, not the UTC 6 AM / raw ISO?
const modelProvider = createMuseRuntimeAssembly().modelProvider;
const system = `You are Muse, a personal assistant. You just called the \`muse.calendar.add\` tool. Here is that tool's documentation:\n\n${addTool.description}\n\nWrite ONE short sentence confirming the event to the user, based on the tool result below. State the start time.`;
const user = `Tool result:\n${JSON.stringify(result)}`;
const resp = await modelProvider.generate({ maxOutputTokens: 160, messages: [{ content: system, role: "system" }, { content: user, role: "user" }], model, temperature: 0 });
const out = (resp.output ?? "").toLowerCase();

const saysLocal = /3:00\s*pm|3\s*pm|3pm|3 in the afternoon|15:00/u.test(out);
const saysRawUtc = /6:00\s*am|6\s*am|6am|t06:00|2026-06-\d\dt/u.test(out);
check(
  "model confirms the event with the LOCAL 3 PM, not the UTC 6 AM / raw ISO",
  saysLocal && !saysRawUtc,
  out.slice(0, 200)
);

console.log(failures === 0 ? `\nALL PASS (2) on ${model}` : `\n${failures}/2 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
