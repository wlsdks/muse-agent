import { isErrorLike } from "@muse/shared";
/**
 * Live verification of the in-chat tool-approval gate against the REAL
 * local-Qwen runtime (LOCAL OLLAMA ONLY, per testing.md). Proves the
 * fail-closed contract end-to-end, not just the unit logic:
 *
 *   1. With metadata.localMode the chat runtime exposes a write tool and
 *      Qwen SELECTS it unprompted (the "right tool in one shot" rule).
 *   2. The toolApprovalGate IS consulted before the write runs.
 *   3. DENY → the write does NOT happen (fail-closed, no external effect).
 *   4. APPROVE → the write DOES happen.
 *
 * Run from apps/cli:  node scripts/verify-chat-approval.mjs
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const tmp = mkdtempSync(path.join(os.tmpdir(), "muse-approval-"));
const tasksFile = path.join(tmp, "tasks.json");
// LOCAL OLLAMA ONLY (testing.md) — pin the model so this never reaches a
// cloud API even if the user's config defaults to one.
const model = process.env.MUSE_APPROVAL_VERIFY_MODEL ?? "ollama/gemma4:12b";
const env = { ...process.env, MUSE_DEFAULT_MODEL: model, MUSE_TASKS_FILE: tasksFile };

const assembly = createMuseRuntimeAssembly({ env });
if (!assembly.agentRuntime) {
  console.error("FAIL: no agentRuntime (model provider not configured)");
  process.exit(2);
}
if (!model.startsWith("ollama/")) {
  console.error(`FAIL: refusing to run against non-local model '${model}' (LOCAL OLLAMA ONLY)`);
  process.exit(2);
}
const TITLE = `buy oat milk ${Date.now()}`;
const prompt = `Add a task to my todo list with the title "${TITLE}". Use your tools.`;

async function run(allow) {
  const consulted = [];
  const stream = assembly.agentRuntime.stream({
    messages: [
      { role: "system", content: "You are Muse, a personal assistant. When the user asks you to add/create something, call the matching tool." },
      { role: "user", content: prompt }
    ],
    metadata: { localMode: true },
    model,
    toolApprovalGate: async ({ toolCall, risk }) => {
      consulted.push({ name: toolCall.name, risk });
      return allow ? { allowed: true } : { allowed: false, reason: "verify-chat-approval deny" };
    }
  });
  for await (const ev of stream) {
    if (ev.type === "error") throw ev.isErrorLike(error) ? ev.error : new Error(String(ev.error));
  }
  return consulted;
}

const written = () => existsSync(tasksFile) && readFileSync(tasksFile, "utf8").includes(TITLE);

const fails = [];
const note = (ok, msg) => { console.log(`${ok ? "  ok" : "FAIL"} — ${msg}`); if (!ok) fails.push(msg); };

console.log(`model=${model}\ntasksFile=${tasksFile}\n`);

console.log("Pass A — gate DENIES:");
const denied = await run(false);
const deniedWrite = denied.some((c) => c.risk === "write" || c.risk === "execute");
note(deniedWrite, `gate consulted for a write/execute tool (got ${JSON.stringify(denied)})`);
note(!written(), "denied write did NOT persist (fail-closed)");

console.log("\nPass B — gate APPROVES:");
const approved = await run(true);
const approvedWrite = approved.some((c) => c.risk === "write" || c.risk === "execute");
note(approvedWrite, `gate consulted for a write/execute tool (got ${JSON.stringify(approved)})`);
note(written(), "approved write DID persist");

console.log("");
if (fails.length > 0) {
  console.error(`RESULT: ${fails.length} assertion(s) failed`);
  process.exit(1);
}
console.log("RESULT: PASS — in-chat approval gate is fail-closed end-to-end");

