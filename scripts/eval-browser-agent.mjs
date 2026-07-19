/**
 * eval:browser-agent — live browser terminal-state task on the local model.
 *
 * The battery runs inside a disposable HOME and grades the page terminal state
 * plus the grounded answer. Environmental preflight skips are explicit;
 * anything that fails after execution begins is a failed evaluation.
 */
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createBrowserClickTool,
  createBrowserReadTool,
  createBrowserTypeTool,
  PuppeteerBrowserController
} from "../packages/browser/dist/index.js";
import { completionLine, skipLine } from "./eval-skip.mjs";
import { createEvalTrialEnvironment } from "./lib/eval-trial-environment.mjs";
import { allowEvalToolCall, createEvalToolExposureAuthority } from "./lib/eval-tool-authority.mjs";

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/u, "");
const MODEL = process.env.MUSE_EVAL_MODEL?.startsWith("ollama/")
  ? process.env.MUSE_EVAL_MODEL
  : `ollama/${process.env.MUSE_EVAL_MODEL ?? "gemma4:12b"}`;
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT ?? "1")));

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

const TASK =
  `On the already-open Muse Test Shop page, type "wireless mouse" into the search box and submit the search, ` +
  "then tell me the NAME and PRICE of the first search result.";

function logTool(tool) {
  return {
    ...tool,
    execute: async (args, ctx) => {
      const result = await tool.execute(args, ctx);
      if (process.env.MUSE_BROWSER_DEBUG) {
        console.log(`  [tool] ${tool.definition.name}(${JSON.stringify(args)}) → ${JSON.stringify(result).slice(0, 160)}`);
      }
      return result;
    }
  };
}

function printSkip(reason, message) {
  stopped = true;
  console.log(`eval:browser-agent skipped — ${message}.`);
  console.log(skipLine(reason, message));
  console.log(completionLine({ status: "unverified", requested: REPEAT, executed: 0, reason }));
}

async function listen(server) {
  const settled = Promise.withResolvers();
  server.once("error", settled.reject);
  server.listen(0, "127.0.0.1", () => settled.resolve());
  await settled.promise;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose) => server.close(resolveClose));
}

let home;
let environment;
let server;
let controller;
let completedRuns = 0;
let stopped = false;
try {
  home = await mkdtemp(join(tmpdir(), "muse-browser-agent-"));

  try {
    const probe = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(3000) });
    if (!probe.ok) throw new Error(`status ${probe.status}`);
  } catch {
    printSkip("ollama-unreachable", "local Ollama is unreachable");
  }

  if (!stopped && home) {
    try {
      controller = new PuppeteerBrowserController({ headless: true, userDataDir: join(home, "chrome-profile") });
      await controller.open("about:blank");
    } catch {
      printSkip("chrome-missing", "a compatible local Chrome runtime is unavailable");
    }
  }

  if (!stopped && controller) {
    server = createServer((_req, response) => {
      if (process.env.MUSE_BROWSER_DEBUG) console.log(`  [fixture] ${_req.method ?? "GET"} ${_req.url ?? "/"}`);
      response.writeHead(200, { "content-type": "text/html" });
      response.end(SHOP_HTML);
    });
    try {
      await listen(server);
    } catch {
      printSkip("runtime-unavailable", "the local fixture runtime is unavailable");
    }
  }

  if (!stopped && controller && server?.listening) {
    // Chrome already has its own disposable userDataDir. Launch it before
    // replacing HOME: an empty process HOME makes the system Chrome runtime
    // unable to navigate even to loopback on macOS. Muse itself is isolated
    // before autoconfigure is imported or any store is resolved.
    environment = await createEvalTrialEnvironment({
      overrides: { MUSE_DEFAULT_MODEL: MODEL, OLLAMA_BASE_URL: OLLAMA_BASE },
      prefix: "muse-browser-runtime-"
    });
    // Autoconfigure resolves several stores during module initialisation. It
    // must not observe the owner's HOME or inherited cloud-provider settings.
    let createMuseRuntimeAssembly;
    try {
      ({ createMuseRuntimeAssembly } = await import("../packages/autoconfigure/dist/index.js"));
    } catch {
      printSkip("runtime-unavailable", "the Muse runtime assembly is unavailable");
    }

    if (createMuseRuntimeAssembly) {
      const allow = () => ({ approved: true });
      let assembly;
      try {
        assembly = createMuseRuntimeAssembly({
          env: environment.env,
          extraTools: [
            createBrowserReadTool({ controller }),
            createBrowserClickTool({ approvalGate: allow, controller }),
            createBrowserTypeTool({ approvalGate: allow, controller })
          ].map(logTool)
        });
      } catch {
        printSkip("runtime-unavailable", "the Muse runtime assembly could not be configured");
      }
      if (assembly && (!assembly.agentRuntime || !assembly.modelProvider)) {
        printSkip("runtime-unavailable", "the agent runtime or model provider is unavailable");
      } else if (assembly) {
        const url = `http://127.0.0.1:${server.address().port}/shop`;
        let failures = 0;
        try {
          for (let run = 1; run <= REPEAT; run += 1) {
            // Keep the numeric loopback URL out of model-visible text (where
            // the privacy guard correctly treats IP literals as sensitive),
            // while still exercising a real Chrome page and terminal state.
            await controller.open(url);
            const result = await assembly.agentRuntime.run({
              messages: [
                { content: "You are Muse. Use the browser tools to do what the user asks, then answer from what the page showed.", role: "system" },
                { content: TASK, role: "user" }
              ],
              metadata: { userId: "eval-browser-agent" },
              model: assembly.defaultModel,
              toolApprovalGate: allowEvalToolCall,
              toolExposureAuthority: createEvalToolExposureAuthority("browser-agent")
            });
            const answer = result.response?.output ?? "";
            const toolsUsed = result.toolsUsed ?? [];
            const snapshot = await controller.snapshot();
            const pageSearched = snapshot.text.includes("searched-for: wireless mouse");
            const answerHasName = /aeroglide/iu.test(answer);
            const answerHasPrice = /32[,.]?000/u.test(answer);
            const ok = pageSearched && answerHasName && answerHasPrice;
            if (!ok) failures += 1;
            completedRuns += 1;
            console.log(`run ${run.toString()}/${REPEAT.toString()}: ${ok ? "PASS" : "FAIL"}  page-searched=${pageSearched.toString()} name=${answerHasName.toString()} price=${answerHasPrice.toString()} tools=[${toolsUsed.join(",")}]`);
            if (!ok) console.log(`  answer: ${answer.slice(0, 240)}`);
          }
        } catch (cause) {
          console.error(`eval:browser-agent execution failed — ${cause instanceof Error ? cause.message : String(cause)}`);
          console.log(completionLine({ status: "failed", requested: REPEAT, executed: completedRuns, reason: "runtime-execution-failed" }));
          process.exitCode = 1;
        }
        if (!process.exitCode) {
          if (failures > 0) {
            console.log(`\neval:browser-agent FAIL — ${failures.toString()}/${REPEAT.toString()} runs failed`);
            console.log(completionLine({ status: "failed", requested: REPEAT, executed: completedRuns, reason: "terminal-state-failed" }));
            process.exitCode = 1;
          } else {
            console.log(`\neval:browser-agent PASS (${REPEAT.toString()}/${REPEAT.toString()} runs — terminal state + grounded answer)`);
            console.log(completionLine({ status: "passed", requested: REPEAT, executed: completedRuns }));
          }
        }
      }
    }
  }
} catch (cause) {
  console.error(`eval:browser-agent failed before execution — ${cause instanceof Error ? cause.message : String(cause)}`);
  console.log(completionLine({ status: "failed", requested: REPEAT, executed: completedRuns, reason: "runtime-execution-failed" }));
  process.exitCode = 1;
} finally {
  await controller?.close().catch(() => {});
  await closeServer(server).catch(() => {});
  if (home) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(home, { force: true, recursive: true });
        break;
      } catch {
        await sleep(400);
      }
    }
  }
  await environment?.dispose();
}
