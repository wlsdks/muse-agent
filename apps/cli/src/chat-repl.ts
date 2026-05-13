/**
 * Chat REPL + supporting helpers. Lives next to program.ts since it
 * shares the createProgram entry-point's `ProgramIO` shape and the
 * autoconfigure runtime assembly.
 *
 * What's here:
 *
 *   - `runChatRepl()` — interactive `muse chat -i` loop. Maintains
 *     in-memory + on-disk history, multi-persona switching, trust
 *     awareness, auto-extract of memory facts after every turn, and
 *     the streaming token render path.
 *   - `runLocalChat()` — single-shot `muse chat "msg" --local` that
 *     drives the agent runtime without REPL plumbing.
 *   - `createTuiChatSubmitter()` — the `(message) => Promise<text>`
 *     callback the Ink TUI feeds each user submission into.
 *   - `resolveChatMessage()` / `readPipedStdin()` — input resolution
 *     so `cat doc.md | muse chat "summarize"` works.
 *   - `parseAgentMode()` / `AgentMode` / `readChatResponseText()` —
 *     small parsers used across the chat path.
 */

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import type { Command } from "commander";

import { isRecord } from "./credential-store.js";
import {
  appendActivity,
  appendLastChatTurn,
  clearLastChatHistory,
  maybeCompactLastChatHistory,
  parseRoutineUpdateMs,
  readLastChatHistory
} from "./chat-history.js";
import { buildJarvisPersona, formatCurrentContextLine } from "./jarvis-persona.js";
import {
  apiRequest,
  promptText,
  readApiOptions,
  writeRunLog
} from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

export type AgentMode = "react" | "plan_execute";

export async function resolveChatMessage(io: ProgramIO, messageParts: readonly string[]): Promise<string> {
  const message = messageParts.join(" ").trim();
  const piped = await (io.readPipedStdin ?? readPipedStdin)();

  // Daily-driver ergonomic: `cat doc.md | muse chat "summarize"` should
  // concatenate piped stdin AFTER the args so the model sees the
  // instruction first. When only stdin is provided, use it directly.
  // Falls back to the interactive prompt only on a true TTY with no
  // args + no pipe.
  if (message.length > 0 && piped.length > 0) {
    return `${message}\n\n${piped}`;
  }
  if (message.length > 0) {
    return message;
  }
  if (piped.length > 0) {
    return piped;
  }

  return promptText(io, {
    message: "What would you like to ask Muse?",
    placeholder: "Compare these options..."
  });
}

export async function readPipedStdin(): Promise<string> {
  // Skip when stdin is a TTY — interactive shells leave stdin attached
  // even when no one's typing; reading it would block forever.
  //
  // Note: Node sets `process.stdin.isTTY` to `true` for a terminal and
  // leaves it `undefined` when stdin is redirected. So the guard has
  // to be a truthy check; `!== false` would treat `undefined` as
  // "still a TTY" and miss the pipe case.
  if (process.stdin.isTTY) {
    return "";
  }
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw.trim();
}

export function createTuiChatSubmitter(
  io: ProgramIO,
  command: Command,
  options: { readonly local: boolean; readonly model?: string }
): (message: string) => Promise<string> {
  return async (message: string) => {
    const body = options.local
      ? await runLocalChat(io, message, options.model)
      : await apiRequest(io, command, "/api/chat", {
        message,
        model: options.model
      });
    const apiOptions = await readApiOptions(io, command, { includeStoredToken: false });

    await writeRunLog(io.workspaceDir ?? process.cwd(), {
      apiUrl: apiOptions.baseUrl,
      message,
      model: options.model,
      response: body,
      source: options.local ? "cli.local" : "cli.remote"
    });

    return readChatResponseText(body);
  };
}

/**
 * Continuous chat REPL — `muse chat -i`. One readline loop, each line
 * is a turn, slash commands manage session state. Lives next to
 * `runLocalChat` because it shares the assembly creation + history
 * persistence; the REPL just amortises that cost across many turns.
 *
 * Slash commands:
 *   /exit, /quit           — leave (Ctrl-D / Ctrl-C work too)
 *   /reset                 — clear in-memory + on-disk history
 *   /history               — show how many turns are in context
 *   /model <tag>           — switch to a different model mid-session
 *   /tools on|off          — toggle the tool registry for subsequent turns
 *   /help                  — list these
 *
 * In-memory history is the source of truth during the session;
 * `~/.muse/last-chat.jsonl` is updated after every assistant reply so
 * a crash mid-conversation doesn't lose the trail and a follow-up
 * `muse chat -c` outside the REPL still picks up where the user
 * left off.
 */
export async function runChatRepl(
  io: ProgramIO,
  options: {
    readonly model: string | undefined;
    readonly disableTools: boolean;
    readonly continueHistory: boolean;
    readonly userId?: string;
    readonly persona?: string;
  }
): Promise<void> {
  const readline = await import("node:readline/promises");
  // Long-session compaction: if last-chat.jsonl has grown past the
  // compact threshold, summarize the old turns and rewrite the file
  // before seeding history. Falls through cleanly on failure.
  if (options.continueHistory) {
    try {
      const probeAssembly = io.createRuntimeAssembly?.() ?? createMuseRuntimeAssembly();
      if (probeAssembly.modelProvider && (options.model ?? probeAssembly.defaultModel)) {
        const compaction = await maybeCompactLastChatHistory(
          probeAssembly.modelProvider as Parameters<typeof maybeCompactLastChatHistory>[0],
          options.model ?? probeAssembly.defaultModel ?? "default"
        );
        if (compaction.compacted) {
          process.stderr.write(`(compacted ${compaction.dropped.toString()} older line(s) into a summary)\n`);
        }
      }
    } catch { /* compaction is best-effort */ }
  }
  const seedHistory = options.continueHistory ? await readLastChatHistory() : [];
  const history: { role: "user" | "assistant"; content: string }[] = [...seedHistory];
  let currentModel = options.model;
  let toolsDisabled = options.disableTools;
  const baseUserId = options.userId ?? process.env.MUSE_USER_ID ?? process.env.USER ?? "default";
  // Multi-persona: the on-disk store keys persona slots as
  // `<user>@<persona>` so a single human ("stark") can have a
  // distinct work / home / hobby context with its own facts,
  // prefs, vetoes, goals. No persona suffix → the bare userId.
  // Persona resolution order: explicit --persona > shell env > none.
  // Setting `export MUSE_PERSONA=work` in a shell-rc lets the user
  // skip --persona on every invocation while keeping the in-session
  // /persona switch operational. P1 from agent-capability-audit.md.
  let currentPersona = options.persona?.trim() ?? process.env.MUSE_PERSONA?.trim();
  const composeUserKey = (): string => currentPersona && currentPersona.length > 0
    ? `${baseUserId}@${currentPersona}`
    : baseUserId;
  let userId = composeUserKey();

  // Build the runtime assembly once and reuse across turns; the
  // streaming loop calls `agentRuntime.stream(...)` directly so
  // text-delta tokens land in the terminal as the model emits them
  // (true JARVIS feel — text appears, doesn't pop in all at once).
  if (currentModel && !process.env.MUSE_MODEL) {
    process.env.MUSE_MODEL = currentModel;
  }
  if (currentModel && currentModel.startsWith("ollama/") && !process.env.MUSE_MODEL_PROVIDER_ID) {
    process.env.MUSE_MODEL_PROVIDER_ID = "ollama";
  }
  const assembly = io.createRuntimeAssembly?.() ?? createMuseRuntimeAssembly();
  if (!assembly.agentRuntime) {
    throw new Error("REPL requires a configured model — set MUSE_MODEL (or pass --model) and re-run.");
  }
  const agentRuntime = assembly.agentRuntime;
  const memoryStore = assembly.userMemoryStore;

  // Resolve the per-user trust list once at REPL start. The tool-using
  // path passes blocked tools through `metadata.forbiddenToolNames`,
  // which the existing DefaultToolExposurePolicy already honours.
  // Trusted tools list is reserved for future "auto-approve" gates;
  // for now it's informational (visible via /whoami extension).
  const { readTrust } = await import("./commands-trust.js");
  let trust = await readTrust(userId).catch(() => ({ blockedTools: [] as string[], trustedTools: [] as string[] }));
  // Pull the auto-extract helpers (re-exported from autoconfigure so
  // the CLI doesn't need @muse/memory as a direct dep). Imported
  // lazily so the test harness can stub the assembly without
  // exercising this path.
  const autoconfigureHelpers = await import("@muse/autoconfigure").catch(() => undefined);
  const autoExtract = autoconfigureHelpers?.pickAutoExtractSystemPrompt
    ? {
        pickSystemPrompt: autoconfigureHelpers.pickAutoExtractSystemPrompt,
        extractJsonObject: autoconfigureHelpers.extractJsonObject
      }
    : undefined;

  // Look up persistent user memory for this identity. The "what
  // makes Muse JARVIS-class" core: every session opens with the
  // facts/preferences the user told Muse in prior sessions. The
  // store is file-backed by default (~/.muse/user-memory.json) so
  // a fresh `muse repl` 30 seconds after the last one already
  // knows the user's name, language, and reply style.
  let userMemory = memoryStore ? await Promise.resolve(memoryStore.findByUserId(userId)) : undefined;
  const personaPrompt = (): string | undefined => {
    if (!userMemory) return undefined;
    return buildJarvisPersona(userMemory, userId);
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  // Append a session marker to the activity log so `muse routine`
  // can later infer active-hours patterns. Best-effort; failures
  // never block the REPL.
  await appendActivity({ kind: "repl-start", userId }).catch(() => undefined);

  // Auto-refresh routine fact when stale (≥ 7 d since last update).
  // Background fire-and-forget — keeps the persona's
  // `routine_active_hours` current without forcing the user to
  // run `muse routine --apply` periodically. JARVIS keeps its
  // model of the user current.
  if (memoryStore) {
    const lastRoutineUpdateMs = parseRoutineUpdateMs(userMemory);
    const staleDays = (Date.now() - lastRoutineUpdateMs) / 86_400_000;
    if (staleDays >= 7) {
      void (async () => {
        try {
          const { activityPath, computeRoutine, readActivity } = await import("./commands-routine.js");
          const rows = await readActivity(activityPath());
          const cutoff = Date.now() - 30 * 86_400_000;
          const filtered = rows.filter((row) => row.userId === userId && new Date(row.tsIso).getTime() >= cutoff);
          if (filtered.length < 5) return; // not enough signal yet
          const summary = computeRoutine(filtered);
          if (summary.topHours.length === 0) return;
          const hoursFact = summary.topHours.map((h) => h.toString().padStart(2, "0")).join(",");
          const daysFact = summary.topDays.join(",");
          await Promise.resolve(memoryStore.upsertFact(userId, "routine_active_hours", hoursFact));
          if (daysFact) {
            await Promise.resolve(memoryStore.upsertFact(userId, "routine_active_days", daysFact));
          }
          userMemory = await Promise.resolve(memoryStore.findByUserId(userId));
        } catch { /* fail-open */ }
      })();
    }
  }

  io.stdout("\n");
  io.stdout("Muse REPL — type /help for commands, /exit to quit.\n");
  io.stdout(`  user: ${userId}, model: ${currentModel ?? assembly.defaultModel ?? "(default)"}, tools: ${toolsDisabled ? "off" : "on"}, history: ${history.length.toString()} turns\n`);
  if (userMemory) {
    const factCount = Object.keys(userMemory.facts).length;
    const prefCount = Object.keys(userMemory.preferences).length;
    if (factCount + prefCount > 0) {
      io.stdout(`  remembered: ${factCount.toString()} fact(s), ${prefCount.toString()} pref(s) (type /whoami)\n`);
    }
  }
  io.stdout("\n");

  let active = true;
  const onSigint = (): void => {
    io.stdout("\n(ctrl-c — exiting)\n");
    active = false;
    rl.close();
  };
  rl.on("SIGINT", onSigint);

  try {
    while (active) {
      let line: string;
      try {
        line = await rl.question("you> ");
      } catch {
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed.startsWith("/")) {
        const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
        const arg = rest.join(" ").trim();
        switch (cmd) {
          case "exit":
          case "quit":
            io.stdout("(bye)\n");
            active = false;
            break;
          case "reset":
            history.length = 0;
            await clearLastChatHistory();
            io.stdout("(history cleared)\n");
            break;
          case "history":
            io.stdout(`(${history.length.toString()} turns in context)\n`);
            break;
          case "model":
            if (arg.length === 0) {
              io.stdout(`(current model: ${currentModel ?? "(default)"})\n`);
            } else {
              currentModel = arg;
              io.stdout(`(model → ${arg})\n`);
            }
            break;
          case "tools":
            if (arg === "on") {
              toolsDisabled = false;
              io.stdout("(tools on)\n");
            } else if (arg === "off") {
              toolsDisabled = true;
              io.stdout("(tools off — chat-only fast path)\n");
            } else {
              io.stdout(`(tools currently ${toolsDisabled ? "off" : "on"}; usage: /tools on|off)\n`);
            }
            break;
          case "fact":
          case "pref": {
            const eq = arg.indexOf("=");
            if (eq < 0 || !memoryStore) {
              io.stdout(`(usage: /${cmd} <key>=<value>${memoryStore ? "" : "; no user-memory store available"})\n`);
              break;
            }
            const key = arg.slice(0, eq).trim();
            const value = arg.slice(eq + 1).trim();
            if (key.length === 0 || value.length === 0) {
              io.stdout(`(usage: /${cmd} <key>=<value>)\n`);
              break;
            }
            await Promise.resolve(
              cmd === "fact"
                ? memoryStore.upsertFact(userId, key, value)
                : memoryStore.upsertPreference(userId, key, value)
            );
            userMemory = await Promise.resolve(memoryStore.findByUserId(userId));
            io.stdout(`(remembered ${cmd}.${key}=${value})\n`);
            break;
          }
          case "whoami":
            if (!userMemory) {
              io.stdout(`(no memory for user '${userId}' yet — try /fact name=YourName)\n`);
            } else {
              io.stdout(`user: ${userId}\n`);
              for (const [key, value] of Object.entries(userMemory.facts)) {
                io.stdout(`  fact.${key}: ${value}\n`);
              }
              for (const [key, value] of Object.entries(userMemory.preferences)) {
                io.stdout(`  pref.${key}: ${value}\n`);
              }
            }
            break;
          case "persona":
            if (arg.length === 0) {
              io.stdout(`(current persona: ${currentPersona ?? "(none — base profile)"}; usage: /persona work | /persona home | /persona none)\n`);
            } else {
              const next = arg === "none" || arg === "off" || arg === "default" ? undefined : arg;
              currentPersona = next;
              userId = composeUserKey();
              userMemory = memoryStore ? await Promise.resolve(memoryStore.findByUserId(userId)) : undefined;
              trust = await readTrust(userId).catch(() => ({ blockedTools: [] as string[], trustedTools: [] as string[] }));
              io.stdout(`(persona → ${currentPersona ?? "(base)"}; userKey=${userId})\n`);
              if (userMemory) {
                const factCount = Object.keys(userMemory.facts).length;
                const prefCount = Object.keys(userMemory.preferences).length;
                io.stdout(`  remembered: ${factCount.toString()} fact(s), ${prefCount.toString()} pref(s) for this persona\n`);
              } else {
                io.stdout(`  (no memory for this persona yet — start fresh)\n`);
              }
            }
            break;
          case "trust":
            io.stdout(`  trust for ${userId}:\n`);
            io.stdout(`    + trusted (${trust.trustedTools.length.toString()}): ${trust.trustedTools.join(", ") || "(none)"}\n`);
            io.stdout(`    × blocked (${trust.blockedTools.length.toString()}): ${trust.blockedTools.join(", ") || "(none)"}\n`);
            break;
          case "remember": {
            // Natural-language LLM extraction → upsert into memory.
            // Mirrors the top-level `muse remember` command but works
            // in-REPL so the user can teach JARVIS mid-conversation.
            if (arg.length === 0 || !assembly.modelProvider) {
              io.stdout(`(usage: /remember <text>; requires a configured model)\n`);
              break;
            }
            try {
              const sysPrompt = autoExtract?.pickSystemPrompt(arg) ?? "Extract user facts as JSON.";
              let raw = "";
              for await (const ev of assembly.modelProvider.stream({
                messages: [
                  { content: sysPrompt, role: "system" },
                  { content: `User turn:\n${arg}\n\nAssistant reply:\n(no reply — extract from the statement)`, role: "user" }
                ],
                model: currentModel ?? assembly.defaultModel ?? "default"
              })) {
                if (ev.type === "text-delta" && typeof ev.text === "string") raw += ev.text;
              }
              const payload = autoExtract?.extractJsonObject(raw);
              if (!payload || !memoryStore) {
                io.stdout("(nothing extracted — try rephrasing)\n");
                break;
              }
              let wrote = 0;
              for (const [k, v] of Object.entries(payload.facts ?? {})) {
                if (typeof v === "string" && v.length > 0) {
                  await Promise.resolve(memoryStore.upsertFact(userId, k, v));
                  io.stdout(`  + fact.${k} = ${v}\n`);
                  wrote += 1;
                }
              }
              for (const [k, v] of Object.entries(payload.preferences ?? {})) {
                if (typeof v === "string" && v.length > 0) {
                  await Promise.resolve(memoryStore.upsertPreference(userId, k, v));
                  io.stdout(`  + pref.${k} = ${v}\n`);
                  wrote += 1;
                }
              }
              for (const slot of payload.vetoes ?? []) {
                if (slot && typeof slot.value === "string" && slot.value.length > 0) {
                  const k = `veto:${slot.id || slot.value.slice(0, 24)}`;
                  await Promise.resolve(memoryStore.upsertPreference(userId, k, slot.value));
                  io.stdout(`  + ${k} = ${slot.value}\n`);
                  wrote += 1;
                }
              }
              for (const slot of payload.goals ?? []) {
                if (slot && typeof slot.value === "string" && slot.value.length > 0) {
                  const k = `goal:${slot.id || slot.value.slice(0, 24)}`;
                  await Promise.resolve(memoryStore.upsertPreference(userId, k, slot.value));
                  io.stdout(`  + ${k} = ${slot.value}\n`);
                  wrote += 1;
                }
              }
              userMemory = await Promise.resolve(memoryStore.findByUserId(userId));
              io.stdout(`(remembered ${wrote.toString()} item(s))\n`);
            } catch (cause) {
              io.stderr(`(/remember failed: ${cause instanceof Error ? cause.message : String(cause)})\n`);
            }
            break;
          }
          case "forget": {
            if (arg.length === 0 || !memoryStore) {
              io.stdout(`(usage: /forget <key> | /forget --all)\n`);
              break;
            }
            if (arg === "--all" || arg === "all") {
              const dropped = await Promise.resolve(memoryStore.deleteByUserId(userId));
              userMemory = undefined;
              io.stdout(dropped ? `(wiped all memory for ${userId})\n` : `(no memory to wipe)\n`);
              break;
            }
            const k = arg;
            if (!userMemory) {
              io.stdout(`(no memory for ${userId})\n`);
              break;
            }
            const factHit = userMemory.facts[k];
            const prefHit = userMemory.preferences[k] ?? userMemory.preferences[`veto:${k}`] ?? userMemory.preferences[`goal:${k}`];
            if (factHit === undefined && prefHit === undefined) {
              io.stdout(`(key '${k}' not in memory)\n`);
              break;
            }
            // Wipe + rebuild-without (mirrors top-level forget).
            const snapshot = userMemory;
            await Promise.resolve(memoryStore.deleteByUserId(userId));
            for (const [fk, fv] of Object.entries(snapshot.facts)) {
              if (fk !== k) await Promise.resolve(memoryStore.upsertFact(userId, fk, fv));
            }
            for (const [pk, pv] of Object.entries(snapshot.preferences)) {
              if (pk === k || pk === `veto:${k}` || pk === `goal:${k}`) continue;
              await Promise.resolve(memoryStore.upsertPreference(userId, pk, pv));
            }
            userMemory = await Promise.resolve(memoryStore.findByUserId(userId));
            io.stdout(`(forgot ${k})\n`);
            break;
          }
          case "help":
            io.stdout("  /exit, /quit          leave\n");
            io.stdout("  /reset                clear history (both memory + disk)\n");
            io.stdout("  /history              show turn count\n");
            io.stdout("  /model <tag>          switch model (e.g. ollama/qwen2.5:7b-instruct)\n");
            io.stdout("  /tools on|off         toggle tool registry\n");
            io.stdout("  /fact key=value       remember a fact about you (persists across sessions)\n");
            io.stdout("  /pref key=value       remember a preference\n");
            io.stdout("  /whoami               show what Muse knows about you\n");
            io.stdout("  /persona <slot>       switch persona slot (work / home / none); each has its own memory\n");
            io.stdout("  /trust                show this user's trusted + blocked tools\n");
            io.stdout("  /remember <text>      LLM-extract facts/prefs/vetoes/goals from natural language\n");
            io.stdout("  /forget <key>         drop a single fact/pref; /forget --all wipes the persona\n");
            io.stdout("  /help                 this list\n");
            break;
          default:
            io.stdout(`(unknown command: /${cmd ?? ""} — try /help)\n`);
        }
        continue;
      }

      try {
        const persona = personaPrompt();
        // Always ground the model in `now`. When persona is set,
        // buildJarvisPersona already includes the date line; with
        // empty memory, fall back to a system message containing
        // just the date. Same fix as commands-ask.ts —
        // JARVIS shouldn't lose track of what day it is when the
        // user hasn't filed any personal facts.
        const systemContent = persona ?? formatCurrentContextLine();
        const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
          { content: systemContent, role: "system" as const },
          ...history,
          { content: trimmed, role: "user" as const }
        ];
        io.stdout("muse> ");
        let accumulated = "";
        if (toolsDisabled && assembly.modelProvider) {
          // Chat-only fast path: stream tokens directly from the
          // provider. Agent-runtime guards + filters would buffer
          // everything until the response is complete (so they can
          // scrub) — fine for tool-using runs, but kills the
          // token-by-token JARVIS feel. With tools off there's no
          // guard surface that needs the full response anyway.
          for await (const event of assembly.modelProvider.stream({
            messages,
            model: currentModel ?? assembly.defaultModel ?? "default"
          })) {
            if (event.type === "text-delta" && typeof event.text === "string") {
              io.stdout(event.text);
              accumulated += event.text;
            }
          }
        } else {
          // Tool-using path: route through the agent runtime so the
          // tool registry + guards + memory hooks fire. Streams the
          // final text once when the agent settles. Blocked-tool list
          // from `muse trust block <tool>` flows in via
          // `forbiddenToolNames`, which the tool exposure policy
          // hard-filters before the model ever sees the registry.
          const metadata: Record<string, string | number | readonly string[]> = {};
          if (toolsDisabled) metadata.maxTools = 0;
          if (trust.blockedTools.length > 0) {
            metadata.forbiddenToolNames = trust.blockedTools;
          }
          for await (const event of agentRuntime.stream({
            messages,
            ...(Object.keys(metadata).length > 0 ? { metadata: metadata as Record<string, string | number> } : {}),
            model: currentModel ?? assembly.defaultModel ?? "default"
          })) {
            if (event.type === "text-delta") {
              io.stdout(event.text);
              accumulated += event.text;
            }
          }
        }
        io.stdout("\n\n");
        history.push({ content: trimmed, role: "user" });
        history.push({ content: accumulated, role: "assistant" });
        await appendLastChatTurn({ message: trimmed, response: accumulated });

        // Fire-and-forget auto-extract: ask the same model to look at
        // the just-finished turn and pull out NEW facts/preferences,
        // then upsert to the persistent store. Failures stay silent
        // (network glitch, model emitted unparseable JSON, etc.) so
        // they never block the next prompt — that's the openclaw
        // differentiation in action: every chat improves what Muse
        // knows about you, but never at the cost of UX.
        if (autoExtract && memoryStore && toolsDisabled && assembly.modelProvider) {
          const turnUser = trimmed;
          const turnAssistant = accumulated;
          void (async () => {
            try {
              const systemPrompt = autoExtract.pickSystemPrompt(turnUser);
              let raw = "";
              for await (const ev of assembly.modelProvider!.stream({
                messages: [
                  { content: systemPrompt, role: "system" },
                  { content: `User turn:\n${turnUser}\n\nAssistant reply:\n${turnAssistant}`, role: "user" }
                ],
                model: currentModel ?? assembly.defaultModel ?? "default"
              })) {
                if (ev.type === "text-delta" && typeof ev.text === "string") {
                  raw += ev.text;
                }
              }
              const payload = autoExtract.extractJsonObject(raw);
              if (!payload) return;
              let wroteAny = false;
              for (const [key, value] of Object.entries(payload.facts ?? {})) {
                if (typeof value === "string" && value.length > 0) {
                  await Promise.resolve(memoryStore.upsertFact(userId, key, value));
                  wroteAny = true;
                }
              }
              for (const [key, value] of Object.entries(payload.preferences ?? {})) {
                if (typeof value === "string" && value.length > 0) {
                  await Promise.resolve(memoryStore.upsertPreference(userId, key, value));
                  wroteAny = true;
                }
              }
              // Encode vetoes + goals as prefixed preferences so the
              // FileUserMemoryStore (which doesn't own a typed-slot
              // column) still persists them. buildJarvisPersona
              // splits them back out for display.
              for (const slot of payload.vetoes ?? []) {
                if (slot && typeof slot.value === "string" && slot.value.length > 0) {
                  const key = `veto:${slot.id || slot.value.slice(0, 24)}`;
                  await Promise.resolve(memoryStore.upsertPreference(userId, key, slot.value));
                  wroteAny = true;
                }
              }
              for (const slot of payload.goals ?? []) {
                if (slot && typeof slot.value === "string" && slot.value.length > 0) {
                  const key = `goal:${slot.id || slot.value.slice(0, 24)}`;
                  await Promise.resolve(memoryStore.upsertPreference(userId, key, slot.value));
                  wroteAny = true;
                }
              }
              if (wroteAny) {
                userMemory = await Promise.resolve(memoryStore.findByUserId(userId));
              }
            } catch {
              // Fail-open. Extraction is opportunistic, not required.
            }
          })();
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        io.stderr(`(error: ${msg})\n`);
      }
    }
  } finally {
    rl.off("SIGINT", onSigint);
    rl.close();
  }
}

export async function runLocalChat(
  io: ProgramIO,
  message: string,
  model: string | undefined,
  agentMode?: AgentMode,
  options: {
    readonly disableTools?: boolean;
    readonly priorHistory?: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  } = {}
) {
  // When the caller passes --model explicitly, push it into the
  // env so the autoconfigure assembly factory wires the matching
  // provider (the assembly is built lazily here, not at module
  // load). Without this, `--model ollama/foo` silently uses
  // whatever provider env inference produced — usually the
  // `gemini/openai/anthropic` first-match — and the run call
  // fails with retry-exhausted because the wrong provider sees
  // an unknown model name.
  if (model && model.length > 0 && !process.env.MUSE_MODEL) {
    process.env.MUSE_MODEL = model;
  }
  if (model && model.startsWith("ollama/") && !process.env.MUSE_MODEL_PROVIDER_ID) {
    process.env.MUSE_MODEL_PROVIDER_ID = "ollama";
  }
  const assembly = io.createRuntimeAssembly?.() ?? createMuseRuntimeAssembly();

  if (!assembly.agentRuntime || !(model ?? assembly.defaultModel)) {
    throw new Error("Local chat requires MUSE_MODEL and a configured model provider");
  }

  const metadata: Record<string, string | number> = {};
  if (agentMode) metadata.agentMode = agentMode;
  if (options.disableTools) metadata.maxTools = 0;
  const hasMetadata = Object.keys(metadata).length > 0;

  // Ground the model in `now` even on the non-interactive
  // `muse chat --local "msg"` path. runLocalChat previously sent
  // ZERO system content, so questions like "what's today's date?"
  // got hallucinated answers (e.g. "Friday 2026-05-12" when the
  // real local now was Wednesday 2026-05-13). Persona/user-memory
  // loading is intentionally NOT done here — the chat one-shot
  // path doesn't have userId plumbed, and the most common
  // hallucination class is the date one. The agent runtime is
  // free to append its own system prompt; this prefix just
  // guarantees the date is always present.
  const messages = [
    { content: formatCurrentContextLine(), role: "system" as const },
    ...(options.priorHistory ?? []),
    { content: message, role: "user" as const }
  ];
  const result = await assembly.agentRuntime.run({
    messages,
    ...(hasMetadata ? { metadata } : {}),
    model: model ?? assembly.defaultModel ?? "default"
  });

  return {
    response: result.response.output,
    runId: result.runId,
    toolsUsed: result.toolsUsed ?? []
  };
}

export function parseAgentMode(value: string | undefined): AgentMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "react" || normalized === "plan_execute") {
    return normalized;
  }
  throw new Error(`--mode must be 'react' or 'plan_execute' (got '${value}')`);
}

export function readChatResponseText(value: unknown): string {
  if (isRecord(value) && typeof value.response === "string") {
    return value.response;
  }

  if (isRecord(value) && typeof value.content === "string") {
    return value.content;
  }

  return JSON.stringify(value);
}
