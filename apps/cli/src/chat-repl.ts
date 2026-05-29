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

import { isRecord } from "./credential-store.js";
import { formatCurrentContextLine } from "./muse-persona.js";
import { loadActivePersonaPreamble } from "./persona-store.js";
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

