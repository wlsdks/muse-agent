/**
 * REAL subprocess stdio contract test for `muse mcp serve` — spawns the
 * actual CLI binary (`node apps/cli/dist/index.js mcp serve`) as a child
 * process and drives it over REAL stdio JSON-RPC (initialize -> tools/list
 * -> tools/call), so subprocess spawn + stdio framing is exercised — not
 * just the in-process protocol round-trip `verify-mcp-serve-grounding.mjs`
 * proves with the SDK's `InMemoryTransport`. Model-free: only exercises the
 * tools that never touch Ollama (tools/list + tasks_read), seeded with a
 * temp tasks file so the round-trip is data-verifiable, not a tautology.
 *
 *   node apps/cli/scripts/verify-mcp-stdio-contract.mjs
 *
 * Exit 0 on all pass; skip (exit 0) only when the CLI dist isn't built or
 * the subprocess fails to spawn/initialize. Any assertion failure AFTER a
 * successful connect always exits 1 — never swallowed as a skip.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runBestEffort } from "../../scripts/best-effort.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(scriptDir, "..", "dist", "index.js");
if (!existsSync(distEntry)) {
  console.log("SKIP: CLI dist not built (run pnpm --filter @muse/cli build)");
  process.exit(0);
}

const EXPECTED_TOOLS = ["muse_recall", "knowledge_search", "user_model_read", "calendar_read", "tasks_read", "propose_action"];
const OPEN_TASK_TITLE = "Renew passport";
const DONE_TASK_TITLE = "Buy oat milk";

const tmpHome = mkdtempSync(path.join(os.tmpdir(), "muse-mcp-stdio-contract-"));
const tasksFile = path.join(tmpHome, ".muse", "tasks.json");
const calendarFile = path.join(tmpHome, ".muse", "calendar.json");
mkdirSync(path.dirname(tasksFile), { recursive: true });
writeFileSync(
  tasksFile,
  `${JSON.stringify(
    {
      tasks: [
        { createdAt: "2026-07-01T09:00:00.000Z", id: "task_seed_open", status: "open", title: OPEN_TASK_TITLE },
        { completedAt: "2026-07-02T10:00:00.000Z", createdAt: "2026-06-30T08:00:00.000Z", id: "task_seed_done", status: "done", title: DONE_TASK_TITLE }
      ]
    },
    null,
    2
  )}\n`,
  "utf8"
);

function definedEnv(source) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
}

let failures = 0;
const fail = (message) => { console.log(`FAIL — ${message}`); failures += 1; };
const pass = (message) => console.log(`PASS — ${message}`);

let client;
try {
  const transport = new StdioClientTransport({
    args: [distEntry, "mcp", "serve"],
    command: process.execPath,
    // Isolate HOME so every other autoconfigure path (notes, memory, model
    // keys) resolves under the temp dir too — only MUSE_TASKS_FILE /
    // MUSE_CALENDAR_FILE are asserted on, but nothing here may touch real
    // user data. MUSE_LOCAL_ONLY keeps model resolution off any ambient
    // cloud key (VQ-17) even though muse_recall is never called.
    env: definedEnv({
      ...process.env,
      HOME: tmpHome,
      MUSE_CALENDAR_FILE: calendarFile,
      MUSE_LOCAL_ONLY: "true",
      MUSE_TASKS_FILE: tasksFile
    })
  });
  client = new Client({ name: "stdio-contract", version: "0" }, { capabilities: {} });
  await client.connect(transport);
} catch (error) {
  console.log(`SKIP: could not spawn muse mcp serve (${error instanceof Error ? error.message : String(error)})`);
  await runBestEffort(() => rmSync(tmpHome, { force: true, recursive: true }), "cleanup failed mcp stdio test home");
  process.exit(0);
}
pass("real subprocess spawned and completed the MCP initialize handshake over stdio");

try {
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const expected of EXPECTED_TOOLS) {
    names.has(expected)
      ? pass(`tools/list exposes '${expected}'`)
      : fail(`tools/list is missing '${expected}' — got [${[...names].join(", ")}]`);
  }

  const allResult = await client.callTool({ arguments: { status: "all" }, name: "tasks_read" });
  if (allResult.isError === true) {
    fail(`tasks_read(status=all) returned a tool error: ${String(allResult.content?.[0]?.text ?? "")}`);
  } else {
    const payload = JSON.parse(String(allResult.content?.[0]?.text ?? "{}"));
    const titles = (payload.tasks ?? []).map((task) => task.title);
    payload.count === 2
      ? pass(`tasks_read(status=all) round-trips both seeded tasks over real stdio (count=${String(payload.count)})`)
      : fail(`tasks_read(status=all) expected count 2, got ${JSON.stringify(payload.count)}`);
    titles.includes(OPEN_TASK_TITLE) && titles.includes(DONE_TASK_TITLE)
      ? pass(`both seeded task titles came back over the wire: ${JSON.stringify(titles)}`)
      : fail(`seeded task titles missing from response: ${JSON.stringify(titles)}`);
  }

  const openResult = await client.callTool({ arguments: { status: "open" }, name: "tasks_read" });
  if (openResult.isError === true) {
    fail(`tasks_read(status=open) returned a tool error: ${String(openResult.content?.[0]?.text ?? "")}`);
  } else {
    const payload = JSON.parse(String(openResult.content?.[0]?.text ?? "{}"));
    payload.count === 1 && (payload.tasks ?? [])[0]?.title === OPEN_TASK_TITLE
      ? pass(`tasks_read(status=open) filters to the single open task over real stdio (${JSON.stringify((payload.tasks ?? [])[0]?.title)})`)
      : fail(`tasks_read(status=open) expected exactly the open task, got ${JSON.stringify(payload)}`);
  }
} catch (error) {
  fail(`unexpected error mid-contract: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await runBestEffort(() => client.close(), "close mcp stdio transport");
  await runBestEffort(() => rmSync(tmpHome, { force: true, recursive: true }), "cleanup temporary mcp stdio test home");
}

console.log(failures === 0 ? "\nverify-mcp-stdio-contract: ALL PASS" : `\nverify-mcp-stdio-contract: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
