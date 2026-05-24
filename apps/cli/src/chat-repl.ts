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
  appendSessionBoundary,
  maybeCompactLastChatHistory,
  parseRoutineUpdateMs,
  readLastChatHistory
} from "./chat-history.js";
import { renderMuseBanner } from "./muse-banner.js";
import { colorize } from "./tty-color.js";
import { buildMusePersona, formatCurrentContextLine } from "./muse-persona.js";
import { loadActivePersonaPreamble } from "./persona-store.js";
import { handleSlashCommand, type SlashContext, type SlashDeps } from "./chat-repl-slash.js";
import {
  apiRequest,
  promptText,
  readApiOptions,
  resolvePersona,
  writeRunLog
} from "./program-helpers.js";
import { closestCommandName } from "./closest-command.js";
import type { ProgramIO } from "./program.js";
import { resolveDefaultUserKey } from "./user-id.js";

const AGENT_MODES: readonly string[] = ["react", "plan_execute"];

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
  // Bound the in-memory history (heap guard for multi-day
  // sessions). The on-disk file stays authoritative; eviction
  // only trims what's passed to the next model call.
  const maxHistoryEntries = resolveReplHistoryCap(process.env.MUSE_REPL_MAX_HISTORY_ENTRIES);
  const trimHistoryIfOversize = (): void => {
    if (history.length > maxHistoryEntries) {
      history.splice(0, history.length - maxHistoryEntries);
    }
  };
  let currentModel = options.model;
  let toolsDisabled = options.disableTools;
  const baseUserId = resolveDefaultUserKey({ override: options.userId });
  // Multi-persona: the on-disk store keys persona slots as
  // `<user>@<persona>` so a single human ("stark") can have a
  // distinct work / home / hobby context with its own facts,
  // prefs, vetoes, goals. No persona suffix → the bare userId.
  // Precedence (`resolvePersona`): explicit --persona > MUSE_PERSONA
  // shell env > none. The in-session `/persona` slash command
  // mutates `currentPersona` directly thereafter.
  let currentPersona = resolvePersona(options.persona);
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
  // Episodic-memory step 4 — load the most-recent N episodes for
  // this userId once at REPL boot and pass them through to the
  // persona block. Best-effort: a missing or corrupt episodes file
  // just means an empty episodes array, not a REPL boot failure.
  const personaEpisodes = await loadPersonaEpisodes(userId).catch(() => []);
  const personaPrompt = (): string | undefined => {
    if (!userMemory) return undefined;
    return buildMusePersona({ ...userMemory, episodes: personaEpisodes }, userId);
  };

  // Immutable references that flow into every slash-command call.
  // The mutable state (userId, userMemory, etc.) goes through a
  // SlashContext built per command instead — see the dispatch site
  // below.
  const slashDeps: SlashDeps = {
    assembly,
    autoExtract,
    composeUserKey,
    memoryStore: memoryStore as SlashDeps["memoryStore"],
    readTrust
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

  // Episodic-memory step 2 — boundary sentinel for the upcoming
  // end-of-session summariser (later step). Writes a `system`-role
  // marker into last-chat.jsonl; `readLastChatHistory` filters it
  // out so the seed history stays clean. Best-effort.
  await appendSessionBoundary({ tsIso: new Date().toISOString(), userId }).catch(() => undefined);

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

  const statusLine = `user: ${userId} · model: ${currentModel ?? assembly.defaultModel ?? "(default)"} · tools: ${toolsDisabled ? "off" : "on"} · history: ${history.length.toString()} turns`;
  let rememberedLine: string | undefined;
  if (userMemory) {
    const factCount = Object.keys(userMemory.facts).length;
    const prefCount = Object.keys(userMemory.preferences).length;
    if (factCount + prefCount > 0) {
      rememberedLine = `remembered: ${factCount.toString()} fact(s), ${prefCount.toString()} pref(s) · /whoami`;
    }
  }
  io.stdout(renderMuseBanner({
    status: statusLine,
    ...(rememberedLine ? { subStatus: rememberedLine } : {}),
    hint: "/help for commands · /exit to quit"
  }));

  let active = true;
  const onSigint = (): void => {
    io.stdout("\n(ctrl-c — exiting)\n");
    active = false;
    rl.close();
  };
  rl.on("SIGINT", onSigint);
  // Without this, SIGTERM bypasses the finally that captures the
  // end-of-session episode. Closing readline rejects its in-flight
  // question promise so control returns to the finally.
  const teardownProcessSignals = wireReplGracefulExit({
    onSignal: (signal) => {
      io.stdout(`\n(${signal} — exiting)\n`);
      active = false;
      rl.close();
    }
  });

  try {
    while (active) {
      let line: string;
      try {
        line = await rl.question(colorize("› ", "cyan"));
      } catch {
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed.startsWith("/")) {
        const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
        const arg = rest.join(" ").trim();
        // Reify the slash-handler context once per command. The handler
        // mutates fields back on this object; observed reads below
        // continue working against the same local bindings via the
        // post-call sync block.
        const slashCtx: SlashContext = {
          active,
          currentModel,
          currentPersona,
          history,
          toolsDisabled,
          trust,
          userId,
          userMemory
        };
        await handleSlashCommand(cmd, arg, slashCtx, slashDeps, io);
        active = slashCtx.active;
        currentModel = slashCtx.currentModel;
        currentPersona = slashCtx.currentPersona;
        toolsDisabled = slashCtx.toolsDisabled;
        trust = slashCtx.trust;
        userId = slashCtx.userId;
        userMemory = slashCtx.userMemory;
        continue;
      }

      try {
        const persona = personaPrompt();
        // Always ground the model in `now`. When persona is set,
        // buildMusePersona already includes the date line; with
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
        io.stdout(colorize("muse ", "cyan"));
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
            if (event.type === "error") {
              // Mirror the agent-runtime path: surface the provider
              // error via the outer catch instead of swallowing it
              // and persisting an empty assistant turn.
              const err = (event as { error?: unknown }).error;
              throw err instanceof Error
                ? err
                : new Error(typeof err === "string" ? err : "model stream failed");
            }
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
        trimHistoryIfOversize();
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
              // column) still persists them. buildMusePersona
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
    teardownProcessSignals();
    rl.close();
    // Episodic-memory step 3b — summarise the just-finished session
    // and persist into ~/.muse/episodes.json. Off by default
    // (MUSE_EPISODIC_MEMORY_ENABLED=true to opt in); fail-soft so
    // a flaky model or filesystem never blocks REPL exit.
    // The ProgramIO type allows a stream-only modelProvider for the
    // test seam; the summariser needs `generate`, so we structural-
    // guard for it before invoking.
    if (assembly.modelProvider && "generate" in assembly.modelProvider) {
      const { captureEndOfSessionEpisode } = await import("./chat-end-session.js");
      await captureEndOfSessionEpisode({
        model: currentModel ?? assembly.defaultModel ?? "default",
        modelProvider: assembly.modelProvider,
        userId
      }).catch(() => undefined);
    }
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

  // System content grounds the model in `now` (date hallucination
  // guard) and the active persona preamble. The preamble is keyed
  // only on the persona id, not userId, so it is safe on this
  // one-shot path unlike the user-memory-folding buildMusePersona.
  const personaPreamble = (await loadActivePersonaPreamble().catch(() => "")).trim();
  const systemContent = personaPreamble.length > 0
    ? `${personaPreamble}\n\n${formatCurrentContextLine()}`
    : formatCurrentContextLine();
  const messages = [
    { content: systemContent, role: "system" as const },
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
  const suggestion = closestCommandName(normalized, AGENT_MODES);
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(`--mode must be 'react' or 'plan_execute' (got '${value}')${hint}`);
}

/**
 * Episodic-memory step 4 — resolve the N most-recent prior-session
 * episodes for the given userId and shape them for the persona
 * block. Caller invokes once per REPL boot; the result feeds
 * `buildMusePersona`'s new `episodes` field.
 *
 * `MUSE_EPISODIC_MEMORY_MAX_ENTRIES` (default 20) caps the block;
 * 0 / negative / non-numeric values fall back to the default rather
 * than producing nonsense like "render -3 entries".
 *
 * The default went 5 → 20 once we decided to skip vector RAG. At
 * personal scale (≤ a few hundred episodes over the assistant's
 * lifetime) the cheaper play is to surface enough episodes in the
 * persona block that the LLM can do paraphrase matching natively
 * (e.g. "Notion thing" → matches "Q3 budget memo" tagged "Notion").
 * 20 entries at ~80 tokens each ≈ 1.6 K tokens of persona — fits
 * comfortably alongside the rest of the prompt on modern context
 * windows.
 */
async function loadPersonaEpisodes(
  userId: string
): Promise<readonly { readonly endedAt: string; readonly summary: string; readonly topics?: readonly string[] }[]> {
  const { readEpisodes } = await import("@muse/mcp");
  const { resolveEpisodesFile } = await import("@muse/autoconfigure");
  const file = resolveEpisodesFile(process.env as Record<string, string | undefined>);
  const all = await readEpisodes(file);
  const capRaw = Number(process.env.MUSE_EPISODIC_MEMORY_MAX_ENTRIES);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.trunc(capRaw) : 20;
  return all
    .filter((entry) => entry.userId === userId)
    .sort((left, right) => right.endedAt.localeCompare(left.endedAt))
    .slice(0, cap)
    .map((entry) => ({
      endedAt: entry.endedAt,
      summary: entry.summary,
      ...(entry.topics && entry.topics.length > 0 ? { topics: entry.topics } : {})
    }));
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

/**
 * Goal 034 — resolve the REPL in-memory history cap from an env
 * string. Default 2000 entries (1000 user/assistant pairs). Bad /
 * non-positive values fall back to the default so a typoed env
 * doesn't accidentally disable bounding.
 */
export function resolveReplHistoryCap(raw: string | undefined): number {
  if (!raw) return 2000;
  const trimmed = raw.trim();
  // Strict integer match: `Number.parseInt("100x", 10) === 100` silently
  // accepts unit-slip / typo'd suffixes — a user typing `100x` would
  // get a 100-entry cap instead of falling back to the documented
  // default. The regex gate rejects anything that isn't a clean
  // optional-sign + digits, matching the same pattern goals 463/469/470
  // established for query-param strict-parse.
  if (!/^[+-]?\d+$/u.test(trimmed)) return 2000;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2000;
  return parsed;
}

/**
 * Goal 072 — wire process-level SIGTERM + SIGINT to a single
 * graceful-exit callback. Returns a teardown function that
 * removes both listeners (call from the REPL's `finally` block
 * so the next REPL instance installs fresh listeners). Exported
 * for direct unit-test coverage — the chat REPL itself can't be
 * driven from a vitest worker without a real TTY.
 */
export function wireReplGracefulExit(args: {
  readonly onSignal: (signal: NodeJS.Signals) => void;
}): () => void {
  const sigterm = (): void => args.onSignal("SIGTERM");
  const sigintProcess = (): void => args.onSignal("SIGINT");
  process.once("SIGTERM", sigterm);
  process.once("SIGINT", sigintProcess);
  return () => {
    process.off("SIGTERM", sigterm);
    process.off("SIGINT", sigintProcess);
  };
}

