/**
 * `muse chat` helpers (one-shot + input/parsing). Lives next to program.ts
 * since it shares the createProgram entry-point's `ProgramIO` shape and the
 * autoconfigure runtime assembly. The interactive surface is the Ink chat
 * (`chat-ink.ts`); the old readline REPL that used to live here is retired.
 *
 * What's here:
 *
 *   - `runLocalChat()` — single-shot `muse chat "msg" --local` that
 *     drives the agent runtime.
 *   - `createTuiChatSubmitter()` — the `(message) => Promise<text>`
 *     callback the status TUI feeds each user submission into.
 *   - `resolveChatMessage()` / `readPipedStdin()` — input resolution
 *     so `cat doc.md | muse chat "summarize"` works.
 *   - `parseAgentMode()` / `AgentMode` / `readChatResponseText()` —
 *     small parsers used across the chat path.
 *   - `wireReplGracefulExit()` — SIGTERM/SIGINT teardown helper (used by
 *     `muse traces` too).
 */

import type { Readable } from "node:stream";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import type { Command } from "commander";

import { classifyCasualPrompt } from "@muse/agent-core";

import { conversationMatches, factKeysToInject, gateChatAnswer, groundedNoteSources, retrieveChatGrounding, stripTruncatedCitation, withGroundingReceipt } from "./chat-grounding.js";
import { isRecord } from "./credential-store.js";
import { buildMusePersona, formatCurrentContextLine } from "./muse-persona.js";
import { loadActivePersonaPreamble } from "./persona-store.js";
import { resolveDefaultUserKey } from "./user-id.js";
import {
  apiRequest,
  promptText,
  readApiOptions,
  writeRunLog
} from "./program-helpers.js";
import { closestCommandName } from "./closest-command.js";
import type { ProgramIO } from "./program.js";

const AGENT_MODES: readonly string[] = ["react", "plan_execute"];

export type AgentMode = "react" | "plan_execute";

export async function resolveChatMessage(
  io: ProgramIO,
  messageParts: readonly string[],
  interactiveAllowed: boolean = Boolean(process.stdin.isTTY && process.stdout.isTTY)
): Promise<string> {
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

  // No args + no piped input. The interactive @clack prompt is only valid on a
  // real TTY — under non-TTY/EOF stdin it half-renders, hides the cursor with a
  // `\e[?25l` escape, and exits unhelpfully (a piped/scripted caller is left
  // with a hidden cursor). Fail with a clear, actionable message instead.
  if (!interactiveAllowed) {
    throw new Error(
      "muse chat: no message provided. Pass one (`muse chat \"…\"`), pipe it in " +
      "(`echo \"…\" | muse chat`), or run in an interactive terminal."
    );
  }

  return promptText(io, {
    message: "What would you like to ask Muse?",
    placeholder: "Compare these options..."
  });
}

export interface ReadPipedStdinOptions {
  /**
   * How long to wait for the FIRST byte before giving up and returning "".
   * Real pipes / redirects (`cat f | muse`, `muse < f`) deliver data or EOF
   * within milliseconds; only a non-TTY stdin that never sends data AND never
   * closes (a headless supervisor, an inherited-open fd, the autonomous loop)
   * needs this escape hatch. Default 200ms — invisible to interactive use.
   */
  readonly firstByteTimeoutMs?: number;
  /** Injectable stream for tests; defaults to `process.stdin`. */
  readonly stream?: Readable & { isTTY?: boolean };
}

/**
 * Read piped stdin, or "" when there is none.
 *
 * Skips a TTY (interactive shells leave stdin attached even when no one is
 * typing). Node sets `isTTY` to `true` for a terminal and leaves it
 * `undefined` when stdin is redirected, so the guard is a truthy check.
 *
 * The hard part is a non-TTY stdin that never delivers data AND never EOFs —
 * a headless supervisor, an inherited-open fd, the autonomous loop. A plain
 * `for await (…stdin)` blocks on it forever (this was the long-standing
 * "`muse ask` hangs before its first result" stall). So we wait only briefly
 * for the FIRST byte; once any data arrives we read to EOF with no timeout, so
 * large piped input is never truncated.
 */
export async function readPipedStdin(options: ReadPipedStdinOptions = {}): Promise<string> {
  const stream = options.stream ?? process.stdin;
  if (stream.isTTY) {
    return "";
  }
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? 200;
  stream.setEncoding("utf8");
  return await new Promise<string>((resolve) => {
    let raw = "";
    let gotData = false;
    let done = false;
    const onData = (chunk: string | Buffer): void => {
      gotData = true;
      raw += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", finish);
      stream.off("error", finish);
      stream.pause();
      resolve(raw.trim());
    };
    // Only the FIRST byte is time-bounded: if nothing has arrived we bail,
    // but once data is flowing we wait for the real EOF.
    const timer = setTimeout(() => {
      if (!gotData) finish();
    }, firstByteTimeoutMs);
    stream.on("data", onData);
    stream.once("end", finish);
    stream.once("error", finish);
    stream.resume();
  });
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

/** Keep only the named keys from a fact map (preserving values). */
export function filterFactsToKeys(facts: Readonly<Record<string, string>>, keys: readonly string[]): Record<string, string> {
  const allow = new Set(keys);
  return Object.fromEntries(Object.entries(facts).filter(([key]) => allow.has(key)));
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

  // A bare greeting / social prompt never needs a tool — but projecting the tool
  // schemas into the prompt is what made even "안녕" take ~22s (qwen3:8b's
  // prompt-eval on the big tool block). Detect it deterministically and drop the
  // tools, taking that turn from ~22s to ~2s (measured) with no capability loss.
  const isCasual = classifyCasualPrompt(message) !== null;
  const metadata: Record<string, string | number> = {};
  if (agentMode) metadata.agentMode = agentMode;
  if (options.disableTools || isCasual) {
    metadata.maxTools = 0;
  } else {
    // Cap the tools projected into the prompt to the few most relevant
    // (planForContext ranks by the user message). Projecting the WHOLE registry
    // is what makes a substantive turn ~25s — qwen3:8b's prompt-eval is dominated
    // by the tool block — and tool-calling.md mandates ≤5-7 per turn anyway (more
    // tools = more wrong-selection). Env-overridable; 0/negative disables the cap.
    const cap = Math.trunc(Number(process.env.MUSE_CHAT_MAX_TOOLS ?? "6"));
    if (Number.isFinite(cap) && cap > 0) metadata.maxTools = cap;
  }
  const hasMetadata = Object.keys(metadata).length > 0;

  // System content grounds the model in `now`, the base persona, AND what Muse
  // durably knows about the user (name, language preference, …). Loading the
  // user memory here — like the REPL does — is what lets the desktop chat answer
  // "what's my name?" and honour the stored response-language preference across
  // sessions, instead of forgetting everything the moment the conversation resets.
  const userId = resolveDefaultUserKey({});
  const userMemory = assembly.userMemoryStore
    ? await Promise.resolve(assembly.userMemoryStore.findByUserId(userId)).catch(() => undefined)
    : undefined;
  // qwen3:8b free-associates remembered ENTITY facts into unrelated turns —
  // it volunteered the user's dog in a hydration answer and a "good morning"
  // (a prompt instruction not to was ignored). So gate deterministically by
  // per-fact topic relevance: keep the name + facts the message is actually
  // about + facts no topic covers; drop a covered-but-unasked fact (the dog).
  // This removes the tangent on general/casual AND single-fact recall turns
  // ("내 이름?") without weakening recall for the fact actually asked about.
  const personaMemory = userMemory
    ? { ...userMemory, facts: filterFactsToKeys(userMemory.facts, factKeysToInject(message, Object.keys(userMemory.facts))) }
    : userMemory;
  const userMemoryBlock = personaMemory ? (buildMusePersona(personaMemory, userId) ?? "").trim() : "";
  const personaPreamble = (await loadActivePersonaPreamble().catch(() => "")).trim();
  const { block: groundingBlock, matches } = isCasual
    ? { block: "", matches: [] as Awaited<ReturnType<typeof retrieveChatGrounding>>["matches"] }
    : await retrieveChatGrounding(message);
  const systemContent = [personaPreamble, userMemoryBlock, formatCurrentContextLine()]
    .filter((part) => part.length > 0)
    .join("\n\n") + groundingBlock;
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

  // Deterministic anti-fabrication gate: for a recall of the user's OWN data,
  // refuse honestly when the answer isn't grounded in the evidence (retrieved
  // notes/episodes + this conversation). The durable user-memory is handled by
  // the topic→stored-key check (knownFactKeys), and deliberately NOT folded into
  // the lexical evidence — doing so let a stored value satisfy ANY question and
  // whitewashed a cross-entity conflation ("the cat is 보리", the dog's name).
  const evidence = [...matches, ...conversationMatches(options.priorHistory ?? [])];
  const knownFactKeys = userMemory ? Object.keys(userMemory.facts ?? {}) : [];
  const gated = gateChatAnswer(message, result.response.output, evidence, knownFactKeys);

  // The local model sometimes stops mid-citation, leaving a broken "[from …"
  // fragment; drop it so the clean 📎 receipt can stand in for the source.
  const repaired = stripTruncatedCitation(gated);

  // "Answers from your notes, source quoted": render the source receipt the model
  // often omits inline, so a grounded answer shows WHERE it came from.
  const response = withGroundingReceipt(repaired, groundedNoteSources(matches, repaired), /[가-힣]/u.test(message));

  return {
    response,
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
 * Resolve the N most-recent prior-session
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
 * Resolve the REPL in-memory history cap from an env
 * string. Default 2000 entries (1000 user/assistant pairs). Bad /
 * non-positive values fall back to the default so a typoed env
 * doesn't accidentally disable bounding.
 */
/**
 * Wire process-level SIGTERM + SIGINT to a single
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

