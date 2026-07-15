/**
 * eval:browser-agent — the multi-step browser CHAIN on the live local model.
 *
 * eval:tools proves one-shot SELECTION; this proves gemma4 can carry a real
 * task across tool rounds: open a local fixture shop page → type a query into
 * the search box and submit → read the result → answer. Graded on the
 * TERMINAL STATE, not the path (agent-testing.md): the page itself records
 * the query it actually received, so a fabricated "I searched it" cannot
 * pass, and the answer must carry the product name + price that only render
 * after a real search.
 *
 * LOCAL OLLAMA ONLY; skips (exit 0) when Ollama or Chrome is unavailable.
 *   MUSE_EVAL_REPEAT=3 node scripts/eval-browser-agent.mjs   # pass^k
 */
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createBrowserBackTool,
  createBrowserClickTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserTypeTool,
  PuppeteerBrowserController
} from "../packages/browser/dist/index.js";
import { createMuseRuntimeAssembly } from "../packages/autoconfigure/dist/index.js";
import { runBestEffort } from "./best-effort.mjs";

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT ?? "1")));

try {
  const probe = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(3000) });
  if (!probe.ok) throw new Error(`status ${probe.status}`);
} catch (cause) {
  console.log(`SKIP: Ollama unreachable (${cause instanceof Error ? cause.message : cause})`);
  process.exit(0);
}

const SHOP_HTML = `<!doctype html><html><head><title>Muse Test Shop</title></head><body>
<h1>Muse Test Shop</h1>
<form onsubmit="search(event)">
  <input id="q" aria-label="Search products" placeholder="Search products">
  <button type="submit">Search</button>
</form>
<div id="log"></div>
<ul id="results"></ul>
<script>
function search(e) {
  e.preventDefault();
  const q = document.getElementById("q").value;
  document.getElementById("log").textContent = "searched-for: " + q;
  document.getElementById("results").innerHTML =
    '<li>AeroGlide Wireless Mouse — 32,000 KRW (top pick)</li>' +
    '<li>ThunderPad Wired Mouse — 12,000 KRW</li>';
}
</script></body></html>`;

const dir = await mkdtemp(join(tmpdir(), "muse-browser-agent-"));
await writeFile(join(dir, "shop.html"), SHOP_HTML);
// Serve the fixture over http — browser_open now refuses file:// (a model must
// not read arbitrary local files via the browser; file_read is the bounded
// local path). Loopback-only on an ephemeral port.
const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(SHOP_HTML); });
const serverListen = Promise.withResolvers();
server.once("error", (cause) => serverListen.reject(cause instanceof Error ? cause : new Error(String(cause))));
server.listen(0, "127.0.0.1", () => serverListen.resolve());
await serverListen.promise;
const url = `http://127.0.0.1:${server.address().port}/shop`;

const controller = new PuppeteerBrowserController({ headless: true, userDataDir: join(dir, "profile") });
const allow = () => ({ approved: true });
const logTool = (tool) => ({
  ...tool,
  execute: async (args, ctx) => {
    const result = await tool.execute(args, ctx);
    if (process.env.MUSE_BROWSER_DEBUG) {
      console.log(`  [tool] ${tool.definition.name}(${JSON.stringify(args)}) → ${JSON.stringify(result).slice(0, 160)}`);
    }
    return result;
  }
});
const assembly = createMuseRuntimeAssembly({
  extraTools: [
    createBrowserOpenTool({ controller }),
    createBrowserReadTool({ controller }),
    createBrowserBackTool({ controller }),
    createBrowserClickTool({ approvalGate: allow, controller }),
    createBrowserTypeTool({ approvalGate: allow, controller })
  ].map(logTool)
});
if (!assembly.agentRuntime || !assembly.modelProvider) {
  console.log("SKIP: no agent runtime/model configured");
  process.exit(0);
}

const TASK =
  `Open ${url} in the browser, type "wireless mouse" into the search box and submit the search, ` +
  "then tell me the NAME and PRICE of the first search result.";

let failures = 0;
try {
  for (let run = 1; run <= REPEAT; run += 1) {
    // A fresh page per run so a prior run's search can't leak terminal state.
    await controller.open("about:blank");
    const result = await assembly.agentRuntime.run({
      messages: [
        { content: "You are Muse. Use the browser tools to do what the user asks, then answer from what the page showed.", role: "system" },
        { content: TASK, role: "user" }
      ],
      // localMode arms the execute-risk type/click (the CLI sets this under --actuators).
      metadata: { localMode: true, userId: "eval-browser-agent" },
      model: assembly.defaultModel
    });
    const answer = result.response?.output ?? "";
    const toolsUsed = result.toolsUsed ?? [];
    const snapshot = await controller.snapshot();
    const pageSearched = snapshot.text.includes("searched-for: wireless mouse");
    const answerHasName = /aeroglide/i.test(answer);
    const answerHasPrice = /32[,.]?000/.test(answer);
    const ok = pageSearched && answerHasName && answerHasPrice;
    if (!ok) failures += 1;
    console.log(`run ${run.toString()}/${REPEAT.toString()}: ${ok ? "PASS" : "FAIL"}  page-searched=${pageSearched.toString()} name=${answerHasName.toString()} price=${answerHasPrice.toString()} tools=[${toolsUsed.join(",")}]`);
    if (!ok) console.log(`  answer: ${answer.slice(0, 240)}`);
  }
} finally {
  await runBestEffort(() => controller.close(), "browser controller close");
  server.close();
  // Chrome flushes its profile asynchronously after close — retry the sweep.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { force: true, recursive: true });
      break;
    } catch {
      await sleep(400);
    }
  }
}

if (failures > 0) {
  console.log(`\neval:browser-agent FAIL — ${failures.toString()}/${REPEAT.toString()} runs failed`);
  process.exit(1);
}
console.log(`\neval:browser-agent PASS (${REPEAT.toString()}/${REPEAT.toString()} runs — terminal state + grounded answer)`);
