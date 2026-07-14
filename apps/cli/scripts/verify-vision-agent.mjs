/**
 * Live AGENT-level battery for grounded vision — the FLAG-FREE path: given an
 * image attachment + a natural request, does the agent autonomously SEE the
 * image, extract the facts, and call the right tool so the world changes? Grades
 * the TERMINAL STATE (the calendar / contacts store got the right write), not the
 * trajectory (agent-testing.md). This is the agent-driven complement to
 * eval:vision (which tests the deterministic --auto router).
 *
 *   node apps/cli/scripts/verify-vision-agent.mjs        (ollama/gemma4:12b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA ONLY; skips (exit 0)
 * when Ollama is unreachable. Each case runs the real `muse chat --local --image`
 * in an isolated HOME and asserts the resulting store.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runNodeCommand } from "./run-node-command.mjs";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
try {
  await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
} catch {
  console.log(`verify-vision-agent skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "index.js");
const fixture = (name) => path.join(here, "fixtures", "vision", name);

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : `\n   ${detail}`}`);
  if (!ok) failures += 1;
}

const cases = [
  {
    name: "flyer + 'add to my calendar' → agent writes a calendar event (terminal state)",
    image: "flyer.png",
    request: "Add this event to my calendar.",
    store: ".muse/calendar.json",
    assert: (json) => {
      const e = (json.events ?? [])[0];
      return Boolean(e) && /jazz/i.test(String(e.title ?? "")) && String(e.startsAt ?? "").startsWith("2026-07-18");
    }
  },
  {
    name: "business card + 'save this contact' → agent writes a contact (terminal state)",
    image: "card.png",
    request: "Save this person to my contacts.",
    store: ".muse/contacts.json",
    assert: (json) => {
      const list = Array.isArray(json) ? json : (json.contacts ?? []);
      const c = list[0];
      return Boolean(c) && /sarah kim/i.test(String(c.name ?? ""));
    }
  }
];

for (const c of cases) {
  const home = mkdtempSync(path.join(os.tmpdir(), "muse-vagent-"));
  const env = { ...process.env, HOME: home, TZ: "Asia/Seoul", MUSE_DEFAULT_MODEL: model };
  const r = await runNodeCommand({
    command: process.execPath,
    args: [cli, "chat", "--local", "--image", fixture(c.image), c.request],
    env,
    timeoutMs: 240_000
  });
  let json;
  try {
    json = JSON.parse(readFileSync(path.join(home, c.store), "utf8"));
  } catch {
    const stdoutTail = r.stdout ? `\n   stdout: ${r.stdout.slice(-200)}` : "";
    const stderrTail = r.stderr ? `\n stderr: ${r.stderr.slice(-200)}` : "";
    check(c.name, false, `no ${c.store} written. exit=${r.status}${stdoutTail}${stderrTail}`);
    continue;
  }
  check(c.name, c.assert(json), `store: ${JSON.stringify(json).slice(0, 200)}`);
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
