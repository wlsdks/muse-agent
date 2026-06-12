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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createBrowserBackTool,
  createBrowserClickTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserTypeTool,
  PuppeteerBrowserController
} from "../packages/browser/dist/index.js";
import { createMuseRuntimeAssembly } from "../packages/autoconfigure/dist/index.js";

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

// Multi-step: the stock count lives ONLY on the detail page, reachable only by
// SEARCHING then CLICKING the result — stopping at the results, or fabricating,
// can't surface "7 units".
const SHOP2_HTML = `<!doctype html><html><head><title>Gadget Store</title></head><body>
<h1>Gadget Store</h1>
<form onsubmit="search(event)">
  <input aria-label="Search products" placeholder="Search products">
  <button type="submit">Search</button>
</form>
<ul id="results"></ul>
<script>
function search(e) {
  e.preventDefault();
  document.getElementById("results").innerHTML =
    '<li><a href="aeroglide.html">AeroGlide Wireless Mouse</a></li>' +
    '<li><a href="thunderpad.html">ThunderPad Wired Mouse</a></li>';
}
</script></body></html>`;
const DETAIL_HTML = `<!doctype html><html><head><title>AeroGlide Wireless Mouse</title></head><body>
<h1>AeroGlide Wireless Mouse</h1>
<p>Price: 32,000 KRW</p>
<p>Availability: In stock — 7 units left</p>
</body></html>`;

const dir = await mkdtemp(join(tmpdir(), "muse-browser-agent-"));
await writeFile(join(dir, "shop.html"), SHOP_HTML);
await writeFile(join(dir, "shop2.html"), SHOP2_HTML);
await writeFile(join(dir, "aeroglide.html"), DETAIL_HTML);
await writeFile(join(dir, "thunderpad.html"), "<!doctype html><title>ThunderPad</title><h1>ThunderPad Wired Mouse</h1><p>Out of stock</p>");
const fileUrl = (name) => pathToFileURL(join(dir, name)).href;

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

const SCENARIOS = [
  {
    name: "search",
    task:
      `Open ${fileUrl("shop.html")} in the browser, type "wireless mouse" into the search box and submit the ` +
      "search, then tell me the NAME and PRICE of the first search result.",
    // Terminal state: the page recorded the real query; the answer carries the
    // name + price that only render after a search.
    grade: (answer, snap) => {
      const searched = snap.text.includes("searched-for: wireless mouse");
      const name = /aeroglide/i.test(answer);
      const price = /32[,.]?000/.test(answer);
      return { detail: `searched=${searched} name=${name} price=${price}`, ok: searched && name && price };
    }
  },
  {
    name: "multi-step (search → click result → read detail)",
    task:
      `Open ${fileUrl("shop2.html")} in the browser, search for "wireless mouse", then open the AeroGlide ` +
      "result and tell me how many units are left in stock.",
    // Terminal state: the browser ended on the DETAIL page (only reachable by
    // clicking the result), and the answer carries the stock count "7" that
    // appears ONLY there — stopping at the results, or fabricating, fails.
    grade: (answer, snap) => {
      const onDetail = snap.url.includes("aeroglide");
      const stock = /\b7\b/.test(answer) && /(stock|units|재고)/i.test(answer);
      return { detail: `onDetail=${onDetail} stock7=${stock} url=${snap.url.split("/").pop()}`, ok: onDetail && stock };
    }
  }
];

let failures = 0;
try {
  for (const scenario of SCENARIOS) {
    for (let run = 1; run <= REPEAT; run += 1) {
      // A fresh page per run so prior terminal state can't leak.
      await controller.open("about:blank");
      const result = await assembly.agentRuntime.run({
        messages: [
          { content: "You are Muse. Use the browser tools to do what the user asks, then answer from what the page showed.", role: "system" },
          { content: scenario.task, role: "user" }
        ],
        // localMode arms the execute-risk type/click (the CLI sets this under --actuators).
        metadata: { localMode: true, userId: "eval-browser-agent" },
        model: assembly.defaultModel
      });
      const answer = result.response?.output ?? "";
      const toolsUsed = result.toolsUsed ?? [];
      const { ok, detail } = scenario.grade(answer, await controller.snapshot());
      if (!ok) failures += 1;
      console.log(`[${scenario.name}] run ${run.toString()}/${REPEAT.toString()}: ${ok ? "PASS" : "FAIL"}  ${detail} tools=[${toolsUsed.join(",")}]`);
      if (!ok) console.log(`  answer: ${answer.slice(0, 240)}`);
    }
  }
} finally {
  await controller.close().catch(() => {});
  // Chrome flushes its profile asynchronously after close — retry the sweep.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { force: true, recursive: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

const total = SCENARIOS.length * REPEAT;
if (failures > 0) {
  console.log(`\neval:browser-agent FAIL — ${failures.toString()}/${total.toString()} runs failed`);
  process.exit(1);
}
console.log(`\neval:browser-agent PASS (${total.toString()} runs across ${SCENARIOS.length.toString()} scenarios — terminal state + grounded answer)`);
