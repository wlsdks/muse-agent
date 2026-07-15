#!/usr/bin/env node
/**
 * `muse demo` — narrated end-to-end walkthrough of the JARVIS
 * surface that ships in this repo. Designed so a new contributor
 * (or the user, on a fresh machine) can run ONE command and watch
 * every key piece work together: local LLM, chat with memory,
 * proactive delivery, setup diagnostic, MCP bridge.
 *
 * Credential-free by default. Picks up whatever LLM is available:
 *   1. `MUSE_DEMO_MODEL=ollama/<tag>` if set
 *   2. The highest-tier Qwen 2.5 already pulled in local Ollama
 *   3. Otherwise: gracefully skip the LLM-needing steps and just
 *      run the non-LLM surface (setup status + proactive flat path)
 *
 * Not a test — it's a demo. Failures print red but don't exit non-
 * zero on missing optional pieces (binaries, etc). The dogfood
 * scripts under scripts/dogfood-*.mjs are the regression assertions.
 *
 * Usage:
 *   node scripts/demo.mjs                 # auto-pick model
 *   MUSE_DEMO_MODEL=ollama/qwen2.5:7b-instruct node scripts/demo.mjs
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = new URL("../", import.meta.url);

// ── Step 0: model resolution ─────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

async function listInstalledOllamaModels() {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!resp.ok) return [];
    const body = await resp.json();
    return (body.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

async function pickModel() {
  const forced = (process.env.MUSE_DEMO_MODEL ?? "").trim();
  if (forced) return { explicit: true, modelId: forced };
  const installed = await listInstalledOllamaModels();
  for (const candidate of [
    "qwen2.5:7b-instruct",
    "qwen2.5:3b",
    "qwen2.5:1.5b-instruct"
  ]) {
    if (installed.includes(candidate)) {
      return { explicit: false, modelId: `ollama/${candidate}` };
    }
  }
  return { explicit: false, modelId: undefined };
}

const step = (n, total, title) => {
  console.log("");
  console.log(`─── [${n}/${total}] ${title} ${"─".repeat(Math.max(0, 56 - title.length))}`);
};
const ok = (s) => console.log(`  ✓ ${s}`);
const note = (s) => console.log(`  · ${s}`);
const warn = (s) => console.log(`  ! ${s}`);

const TS_BOOLEAN_TRUE_VALUES = new Set(["1", "on", "true", "yes"]);
function isDemoNativeNotificationEnabled() {
  const raw = process.env.MUSE_DEMO_NATIVE_NOTIFICATION?.trim().toLowerCase();
  return raw !== undefined && TS_BOOLEAN_TRUE_VALUES.has(raw);
}

console.log("");
console.log("Muse JARVIS demo — 5-step end-to-end walkthrough");
console.log("");

const TOTAL_STEPS = 6;
const start = performance.now();

step(0, TOTAL_STEPS, "Resolving local LLM");
const pick = await pickModel();
if (!pick.modelId) {
  warn("No Ollama models installed. Pull one to enable LLM steps:");
  warn("    ollama pull qwen2.5:1.5b-instruct   # 1 GB, snappy");
  warn("    ollama pull qwen2.5:7b-instruct     # 5 GB, recommended");
} else {
  ok(`using ${pick.modelId}${pick.explicit ? " (from MUSE_DEMO_MODEL)" : ""}`);
}

// ── Step 1: chat with memory ─────────────────────────────────────────
step(1, TOTAL_STEPS, "Chat with cross-turn memory");
if (pick.modelId) {
  process.env.MUSE_MODEL = pick.modelId;
  if (pick.modelId.startsWith("ollama/")) {
    process.env.MUSE_MODEL_PROVIDER_ID = "ollama";
  }
  const { createMuseRuntimeAssembly } = await import(new URL("./packages/autoconfigure/dist/index.js", ROOT).href);
  const assembly = createMuseRuntimeAssembly();
  if (!assembly.agentRuntime) {
    warn("agentRuntime undefined — model resolution failed.");
  } else {
    const introduction = "내 이름은 Stark이고 한국어로 짧게 답해줘.";
    const followup = "내 이름이 뭐였지?";
    note(`you> ${introduction}`);
    const t1 = performance.now();
    const r1 = await assembly.agentRuntime.run({
      messages: [{ content: introduction, role: "user" }],
      metadata: { maxTools: 0 },
      model: pick.modelId
    });
    note(`muse> ${r1.response.output.trim()}  (${Math.round(performance.now() - t1)} ms)`);

    note(`you> ${followup}   (--continue: prior turn injected)`);
    const t2 = performance.now();
    const r2 = await assembly.agentRuntime.run({
      messages: [
        { content: introduction, role: "user" },
        { content: r1.response.output, role: "assistant" },
        { content: followup, role: "user" }
      ],
      metadata: { maxTools: 0 },
      model: pick.modelId
    });
    note(`muse> ${r2.response.output.trim()}  (${Math.round(performance.now() - t2)} ms)`);
    // Hangul-aware recall check: the model might say "Stark" (English),
    // "스타크" (Korean transliteration), or "Mr. Stark" / "starking" etc.
    // All three count — the point is the name surfaced in the response.
    const recall = r2.response.output.toLowerCase();
    const hangulRecall = r2.response.output.includes("스타크");
    if (recall.includes("stark") || hangulRecall) {
      ok("Muse recalled the name across turns — JARVIS-class memory works.");
    } else {
      warn(`small model didn't recall (reply: ${r2.response.output.trim().slice(0, 80)})`);
    }
  }
} else {
  note("skipped — no model");
}

// ── Step 2: proactive notice delivered via LogMessagingProvider ──────
step(2, TOTAL_STEPS, "Proactive notice (credential-free)");
const mcp = await import(new URL("./packages/mcp/dist/index.js", ROOT).href);
const messaging = await import(new URL("./packages/messaging/dist/index.js", ROOT).href);
const dir = mkdtempSync(join(tmpdir(), "muse-demo-"));
const tasksFile = join(dir, "tasks.json");
const sidecarFile = join(dir, "proactive-fired.json");
const logFile = join(dir, "notifications.log");
const now = new Date();
const dueAt = new Date(now.getTime() + 5 * 60_000);
writeFileSync(tasksFile, JSON.stringify({
  tasks: [{
    createdAt: now.toISOString(),
    dueAt: dueAt.toISOString(),
    id: "demo-task",
    status: "open",
    title: "Send the Q3 budget memo to Finance"
  }]
}), "utf8");

const registry = new messaging.MessagingProviderRegistry();
registry.register(new messaging.LogMessagingProvider({ file: logFile }));
const summary = await mcp.runDueProactiveNotices({
  destination: "@demo",
  leadMinutes: 10,
  messagingRegistry: registry,
  providerId: "log",
  sidecarFile,
  tasksFile
});
if (summary.fired > 0) {
  const line = readFileSync(logFile, "utf8").trim();
  ok(`delivered: ${line.split("\n").at(-1)}`);
  note(`(tail -f ${logFile} to watch in real-time)`);
} else {
  warn(`no notices fired — summary=${JSON.stringify(summary)}`);
}

// ── Step 3: optional macOS notification ──────────────────────────────
step(3, TOTAL_STEPS, "macOS Notification Center (opt-in)");
if (process.platform === "darwin" && isDemoNativeNotificationEnabled()) {
  try {
    const provider = new messaging.MacosNotificationProvider({ title: "Muse demo" });
    await provider.send({ destination: "@demo", text: "JARVIS surface end-to-end — chat + memory + proactive verified." });
    ok("native popup fired — check Notification Center.");
  } catch (err) {
    warn(`native notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
} else if (process.platform !== "darwin") {
  note(`skipped — non-darwin host (${process.platform})`);
} else {
  note("opt-in via MUSE_DEMO_NATIVE_NOTIFICATION=true|on|yes|1 to see a real popup");
}

// ── Step 4: setup status ─────────────────────────────────────────────
step(4, TOTAL_STEPS, "Setup diagnostic");
const { collectSetupStatusJson } = await import(new URL("./packages/autoconfigure/dist/index.js", ROOT).href);
const snap = await collectSetupStatusJson();
ok(`model: ${snap.model.status === "ok" ? snap.model.muse_model ?? "configured" : "not configured"}`);
ok(`MCP entries: ${snap.mcp.externalServerCount ?? 0}`);
ok(`calendar (local): ${snap.calendar?.local?.status ?? "n/a"}`);
ok(`messaging registry includes: log (always-on)`);

// ── Step 5: morning brief (one-command JARVIS ritual) ────────────────
step(5, TOTAL_STEPS, "muse brief — morning ritual");
if (pick.modelId) {
  try {
    const { spawnSync } = await import("node:child_process");
    // Seed a tmp persona + tasks so the brief has something concrete
    // to summarise. The real user-memory.json keeps its data isolated.
    const briefDir = mkdtempSync(join(tmpdir(), "muse-demo-brief-"));
    const memoryFile = join(briefDir, "user-memory.json");
    const tasksFile = join(briefDir, "tasks.json");
    writeFileSync(memoryFile, JSON.stringify({
      version: 1,
      users: {
        demo: {
          facts: { name: "Demo" },
          preferences: { reply_style: "concise" },
          recentTopics: [],
          updatedAt: new Date().toISOString(),
          userId: "demo"
        }
      }
    }), "utf8");
    const due = new Date(Date.now() + 2 * 3600_000).toISOString();
    writeFileSync(tasksFile, JSON.stringify({
      tasks: [{ createdAt: new Date().toISOString(), dueAt: due, id: "demo-task", status: "open", title: "Send the Q3 budget memo" }]
    }), "utf8");
    process.stdout.write("  muse> ");
    spawnSync(process.execPath, [join(ROOT.pathname, "apps/cli/dist/index.js"), "brief", "--user", "demo"], {
      env: {
        ...process.env,
        MUSE_TASKS_FILE: tasksFile,
        MUSE_USER_MEMORY_FILE: memoryFile
      },
      stdio: ["ignore", "inherit", "inherit"]
    });
  } catch (cause) {
    warn(`brief skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
} else {
  note("skipped — no model");
}

// ── Step 6: Codex / Claude Desktop bridge ────────────────────────────
step(6, TOTAL_STEPS, "External MCP bridge (Codex / Claude Desktop)");
const bridgePath = join(ROOT.pathname, "packages/mcp/bin/muse-mcp-stdio.mjs");
if (existsSync(bridgePath)) {
  ok(`stdio bridge available: packages/mcp/bin/muse-mcp-stdio.mjs`);
  note("register with codex:");
  note(`  codex mcp add muse-tasks -- node ${bridgePath} tasks`);
  note(`  codex mcp add muse-calendar -- node ${bridgePath} calendar`);
} else {
  warn("bridge file not found — rebuild @muse/mcp");
}

const elapsed = ((performance.now() - start) / 1000).toFixed(1);
console.log("");
console.log(`─── Demo complete in ${elapsed} s ${"─".repeat(34)}`);
console.log("");
console.log("Next steps:");
console.log("  muse chat -i --local --no-tools --continue   # interactive REPL");
console.log("  muse setup voice                              # local STT/TTS toolchain probe");
console.log("  pnpm smoke:live                               # real-LLM smoke (12 endpoints)");
console.log("");
