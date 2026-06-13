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

import { createMuseRuntimeAssembly, resolveNotesDir, resolveTasksFile } from "@muse/autoconfigure";
import type { Command } from "commander";

import { actionToolRan, answerClaimsAction, classifyCasualPrompt, classifyContactLookup, classifyCorpusOverview, classifyMetaPrompt, classifyReminderListQuery, classifyTaskListQuery, requestsToolAction } from "@muse/agent-core";

import { detectArithmeticQuery, formatArithmeticResult } from "./arithmetic-query.js";
import { countdownDays, detectCountdownQuery, formatCountdown } from "./countdown-query.js";
import { detectDateQuery, formatDateAnswer, phraseHasTime } from "./date-query.js";
import { detectDateDiffQuery, formatDateDiff } from "./date-diff-query.js";
import { detectTimezoneQuery, formatTimezone } from "./timezone-query.js";
import { buildQueryRewritePrompt, defaultChatConflictEmbedder, factKeysToInject, finalizeGatedChatAnswer, isChatAbstention, needsContextualRewrite, parseQueryRewrite, QUERY_REWRITE_RESPONSE_FORMAT, QUERY_REWRITE_SYSTEM_PROMPT, retrieveChatGrounding } from "./chat-grounding.js";
import { createQwenReverify } from "./grounding-eval-runner.js";
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
import { isTaskCompletionReport, matchCompletedTask } from "./task-completion.js";
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
  options: { readonly local: boolean; readonly model?: string },
  // The chat runner is injectable so the FAILURE path is testable without a live
  // model/API; production keeps the real local/remote dispatch.
  runChat: (message: string) => Promise<unknown> = (message) =>
    options.local
      ? runLocalChat(io, message, options.model)
      : apiRequest(io, command, "/api/chat", { message, model: options.model })
): (message: string) => Promise<string> {
  const source = options.local ? "cli.local" : "cli.remote";
  return async (message: string) => {
    let body: unknown;
    try {
      body = await runChat(message);
    } catch (error) {
      // A FAILED chat run must still leave a `success:false` trace — error-analysis
      // fuel that previously vanished (the run-log was happy-path only). #6 slice 6d.
      await writeRunLog(io.workspaceDir ?? process.cwd(), {
        message,
        ...(options.model !== undefined ? { model: options.model } : {}),
        response: { error: error instanceof Error ? error.message : String(error), success: false },
        source
      }).catch(() => undefined); // best-effort: a logging failure must not mask the original error
      throw error;
    }
    const apiOptions = await readApiOptions(io, command, { includeStoredToken: false });

    await writeRunLog(io.workspaceDir ?? process.cwd(), {
      apiUrl: apiOptions.baseUrl,
      message,
      model: options.model,
      response: body,
      source
    });

    return readChatResponseText(body);
  };
}

// A question ABOUT Muse ("뭐 할 수 있어?") gets a DETERMINISTIC, honest answer.
// Free-composing on the local model over-claims AND was observed dumping an
// unrelated note (the user's wifi password) into a "what can you do?" reply.
// Every clause here is a capability actually verified to work — honesty about
// what Muse can do is the same edge as honesty about recall.
export const DESKTOP_META_KO =
  "저는 당신의 노트와 메모에서 답을 찾아 출처까지 함께 알려드려요. 모르면 추측하지 않고 \"잘 모르겠어요\"라고 솔직히 말씀드려요. " +
  "할 일·리마인더·일정도 추가하고 정리해드릴 수 있어요. 모든 건 이 기기 안에서만 처리되고 밖으로 나가지 않습니다.";
export const DESKTOP_META_EN =
  "I answer from your own notes and memos and quote the exact source — and if I'm not sure, I say so instead of guessing. " +
  "I can also add and organize your tasks, reminders, and calendar events. Everything runs on this device and nothing leaves it.";

/**
 * Render a notes-corpus inventory for "내 노트 뭐 있어?" / "what notes do I have".
 * Top-K recall ranks every note weakly for a whole-corpus query, so the gate
 * abstains ("I can't list them") — wrong; we DO know the corpus. Deterministic,
 * KO/EN by message script, clean notes-relative paths (no home dir).
 */
export function formatNotesOverview(noteFiles: readonly string[], total: number, korean: boolean): string {
  const lines = noteFiles.map((file) => `  • ${file}`);
  const more = total > noteFiles.length
    ? [korean ? `  … 외 ${(total - noteFiles.length).toString()}개 더` : `  … and ${(total - noteFiles.length).toString()} more`]
    : [];
  const head = korean
    ? `저장된 노트가 ${total.toString()}개 있어요. 이 중 무엇이든 물어보시면 출처와 함께 답해드릴게요:`
    : `You have ${total.toString()} note${total === 1 ? "" : "s"}. Ask me about any of them and I'll quote the source:`;
  return [head, ...lines, ...more].join("\n");
}

/** Render the open-task list for the deterministic "내 할일 뭐 있어?" short-circuit.
 *  `dueLocal` is a pre-rendered LOCAL-time string (never the raw UTC ISO). */
export function formatTaskList(
  tasks: readonly { readonly title: string; readonly dueLocal?: string; readonly urgent?: boolean }[],
  korean: boolean
): string {
  if (tasks.length === 0) {
    return korean ? "지금은 열린 할 일이 없어요." : "You have no open tasks right now.";
  }
  const lines = tasks.map((task) => {
    const due = task.dueLocal ? (korean ? ` — ${task.dueLocal} 마감` : ` — due ${task.dueLocal}`) : "";
    const flag = task.urgent ? "⚡ " : "";
    return `  • ${flag}${task.title}${due}`;
  });
  const head = korean
    ? `열린 할 일이 ${tasks.length.toString()}개 있어요:`
    : `You have ${tasks.length.toString()} open task${tasks.length === 1 ? "" : "s"}:`;
  return [head, ...lines].join("\n");
}

/** A deterministic reminder list for the chat surface (parity with formatTaskList). */
export function formatReminderList(
  reminders: readonly { readonly text: string; readonly dueLocal?: string }[],
  korean: boolean
): string {
  if (reminders.length === 0) {
    return korean ? "지금은 예정된 리마인더가 없어요." : "You have no upcoming reminders right now.";
  }
  const lines = reminders.map((reminder) => {
    const due = reminder.dueLocal ? (korean ? ` — ${reminder.dueLocal}` : ` — ${reminder.dueLocal}`) : "";
    return `  • ${reminder.text}${due}`;
  });
  const head = korean
    ? `예정된 리마인더가 ${reminders.length.toString()}개 있어요:`
    : `You have ${reminders.length.toString()} upcoming reminder${reminders.length === 1 ? "" : "s"}:`;
  return [head, ...lines].join("\n");
}

/** One contact's known details on a single line — the deterministic answer to a
 *  "<name> 전화번호 / 관계 / 이메일" lookup the 8B fumbles. */
export function formatContactDetails(
  contact: { readonly name: string; readonly phone?: string; readonly email?: string; readonly handle?: string; readonly relationship?: string; readonly birthday?: string },
  korean: boolean
): string {
  const parts: string[] = [];
  if (contact.phone) parts.push(korean ? `전화 ${contact.phone}` : `phone ${contact.phone}`);
  if (contact.email) parts.push(korean ? `이메일 ${contact.email}` : `email ${contact.email}`);
  if (contact.handle) parts.push(korean ? `핸들 ${contact.handle}` : `handle ${contact.handle}`);
  if (contact.relationship) parts.push(korean ? `관계 ${contact.relationship}` : `relationship ${contact.relationship}`);
  if (contact.birthday) parts.push(korean ? `생일 ${contact.birthday}` : `birthday ${contact.birthday}`);
  if (parts.length === 0) {
    return korean ? `${contact.name} 연락처는 있지만 세부 정보가 저장돼 있지 않아요.` : `${contact.name} is saved, but with no details.`;
  }
  return `${contact.name} — ${parts.join(", ")}`;
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
    /** Inline image attachments (gemma4 vision) for `muse chat --image`. */
    readonly imageAttachments?: ReadonlyArray<{ readonly mimeType: string; readonly dataBase64: string }>;
  } = {}
) {
  // NFC-normalize the message. macOS/Swift passes CLI arguments in NFD (Hangul
  // syllables DECOMPOSED into jamo — "뭐" → ㅁ+ㅜ+ㅓ), so the desktop companion's
  // Korean turns arrived as NFD while every classifier/keyword here is NFC →
  // classifyMetaPrompt / isPersonalFactRecall / tool keywords all silently
  // missed, and the app answered Korean questions with garbage. A direct
  // `bash` spawn passes NFC, which is why the binary tested fine in isolation.
  message = message.normalize("NFC");
  if (options.priorHistory) {
    options = { ...options, priorHistory: options.priorHistory.map((turn) => ({ ...turn, content: turn.content.normalize("NFC") })) };
  }
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

  // A question ABOUT Muse itself short-circuits to a deterministic, honest
  // capability answer BEFORE any model call — the local model otherwise
  // over-claims and (observed) injects an unrelated note into the reply.
  if (classifyMetaPrompt(message)) {
    return { response: /[가-힣]/u.test(message) ? DESKTOP_META_KO : DESKTOP_META_EN, runId: "local-meta", toolsUsed: [] };
  }

  // "내 노트 뭐 있어?" / "what notes do I have" wants the INVENTORY, but top-K
  // recall ranks the whole corpus weakly so the model refused or dumped raw
  // "ref=…" ids. List it deterministically when the user actually has notes.
  if (classifyCorpusOverview(message)) {
    // Lazy import: a STATIC import of the big `commands-ask` module pulls its
    // async-init dependency graph into chat-repl's module init, which the bun
    // `--compile` bundler emits as a top-level `await init_commands_ask()` in a
    // sync context → the bundled desktop binary crashes at startup. Defer it.
    const { listNoteFiles, notesCorpusFileCount } = await import("./commands-ask.js");
    const notesDir = resolveNotesDir(process.env as Record<string, string | undefined>);
    const total = await notesCorpusFileCount(notesDir).catch(() => 0);
    if (total > 0) {
      return {
        response: formatNotesOverview(await listNoteFiles(notesDir), total, /[가-힣]/u.test(message)),
        runId: "local-corpus",
        toolsUsed: []
      };
    }
  }

  // "내 할일 뭐 있어?" — the to-do LIST intent. qwen3:8b reads the possessive
  // "뭐 있어" as a memory question and won't call tasks.list (it DOES for the
  // identical "내 일정 뭐 있어?" → calendar.list), so without this the recall gate
  // wrongly abstains "그건 아직 기억하고 있지 않아요" while open tasks sit on disk.
  // List them deterministically — same remedy as the notes corpus overview above.
  if (classifyTaskListQuery(message)) {
    const { readTasks, compareTasksByDueDate, formatDueLocal } = await import("@muse/mcp");
    const { resolveTasksFile } = await import("@muse/autoconfigure");
    const tasksFile = resolveTasksFile(process.env as Record<string, string | undefined>);
    const open = (await readTasks(tasksFile).catch(() => []))
      .filter((task) => task.status === "open")
      .sort(compareTasksByDueDate);
    return {
      response: formatTaskList(
        open.map((task) => ({
          title: task.title,
          ...(task.dueAt ? { dueLocal: formatDueLocal(task.dueAt) } : {}),
          ...(task.urgent ? { urgent: true } : {})
        })),
        /[가-힣]/u.test(message)
      ),
      runId: "local-tasks",
      toolsUsed: []
    };
  }

  // "리마인더 뭐 있어?" — the reminder LIST intent, the exact sibling of the
  // task-list case above (the 8B reads "뭐 있어" as a memory question and won't
  // call reminders.list, so the recall gate wrongly abstains "없습니다" while
  // pending reminders sit on disk). List the pending ones deterministically.
  if (classifyReminderListQuery(message)) {
    const { readReminders, formatDueLocal } = await import("@muse/mcp");
    const { resolveRemindersFile } = await import("@muse/autoconfigure");
    const remindersFile = resolveRemindersFile(process.env as Record<string, string | undefined>);
    const pending = (await readReminders(remindersFile).catch(() => []))
      .filter((reminder) => reminder.status === "pending")
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return {
      response: formatReminderList(
        pending.map((reminder) => ({ dueLocal: formatDueLocal(reminder.dueAt), text: reminder.text })),
        /[가-힣]/u.test(message)
      ),
      runId: "local-reminders",
      toolsUsed: []
    };
  }

  // "박지훈 전화번호 알려줘" — a contact-detail lookup. The 8B won't call
  // find_contact for these (it abstains, even claiming it has no contact feature),
  // so resolve the named contact deterministically. resolveContact is the
  // precision gate: an unknown name (or a non-contact phrase) falls through to the
  // normal path instead of short-circuiting.
  const contactName = classifyContactLookup(message);
  if (contactName) {
    const { queryContacts, resolveContact } = await import("@muse/mcp");
    const { resolveContactsFile } = await import("@muse/autoconfigure");
    const contacts = await queryContacts(resolveContactsFile(process.env as Record<string, string | undefined>)).catch(() => []);
    const resolution = resolveContact(contacts, contactName);
    const korean = /[가-힣]/u.test(message);
    if (resolution.status === "resolved") {
      return { response: formatContactDetails(resolution.contact, korean), runId: "local-contact", toolsUsed: [] };
    }
    if (resolution.status === "ambiguous") {
      const names = resolution.matches.map((contact) => contact.name).join(", ");
      return {
        response: korean ? `여러 명이 있어요: ${names}. 누구를 말씀하시는 건가요?` : `Several match: ${names}. Which one?`,
        runId: "local-contact",
        toolsUsed: []
      };
    }
    // status "unknown" → not a known contact; fall through to the normal path.
  }

  // Pure arithmetic ("12 times 4", "what is (1200+850)/2") — the local 8B
  // confidently mis-multiplies ("12 times 4" → "24"), so compute it
  // deterministically through the same evaluator the muse.math tool uses rather
  // than trusting the model's digits. The precision-first detector only fires on
  // a query that is NOTHING but a calculation, so a notes question is untouched.
  const arithmeticExpression = detectArithmeticQuery(message);
  if (arithmeticExpression) {
    const { evaluateArithmeticExpression } = await import("@muse/mcp");
    const evaluated = evaluateArithmeticExpression(arithmeticExpression);
    if ("result" in evaluated) {
      return {
        response: formatArithmeticResult(arithmeticExpression, evaluated.result),
        runId: "local-arithmetic",
        toolsUsed: []
      };
    }
  }

  // Sibling deterministic compute fast-paths — the 8B is confidently off-by-days
  // on calendar math (it answered "189 days" and "209 days" for counts whose
  // exact values are 201 and 217). Count those EXACTLY from the host clock, same
  // as the arithmetic path. Each detector is precision-first (falls through to
  // grounded recall unless the query is NOTHING but that computation).
  {
    const datePhrase = detectDateQuery(message);
    if (datePhrase !== null) {
      const { parseReminderDueAt } = await import("@muse/mcp");
      const resolved = parseReminderDueAt(datePhrase, () => new Date());
      if (!(resolved instanceof Error)) {
        return {
          response: formatDateAnswer(datePhrase, resolved, { includeTime: phraseHasTime(datePhrase) }),
          runId: "local-date",
          toolsUsed: []
        };
      }
    }
    const countdown = detectCountdownQuery(message);
    if (countdown) {
      const { parseReminderDueAt } = await import("@muse/mcp");
      const now = new Date();
      const resolved = parseReminderDueAt(countdown.targetPhrase, () => now);
      if (!(resolved instanceof Error)) {
        const days = countdownDays(now, resolved);
        if (days >= 0) {
          return { response: formatCountdown(countdown.unit, days, resolved, countdown.ko), runId: "local-countdown", toolsUsed: [] };
        }
      }
    }
    const dateDiff = detectDateDiffQuery(message, new Date());
    if (dateDiff) {
      return { response: formatDateDiff(dateDiff), runId: "local-date-diff", toolsUsed: [] };
    }
    // Time-zone conversion / "what time is it in X" — the 8B doesn't reliably know
    // offsets or DST (it answered "5am"/"6am" for 3pm New York → Seoul, exact: 4am
    // EDT). formatTimezone computes it DST-correctly from the IANA database.
    const timezone = detectTimezoneQuery(message);
    if (timezone) {
      return { response: formatTimezone(timezone, new Date()), runId: "local-timezone", toolsUsed: [] };
    }
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
  // Multi-turn recall: resolve an anaphoric turn into a self-contained
  // retrieval query (one constrained inference, fail-open to the raw turn).
  // ONLY the retrieval query is rewritten — the model still answers the
  // user's actual message, so a bad rewrite can at worst rank notes poorly,
  // never alter the answer's evidence gate or wording.
  let retrievalQuery = message;
  const rewriteProvider = assembly.modelProvider;
  if (!isCasual && needsContextualRewrite(message, (options.priorHistory ?? []).length) && rewriteProvider && "generate" in rewriteProvider) {
    try {
      const rewritten = await rewriteProvider.generate({
        maxOutputTokens: 80,
        messages: [
          { content: QUERY_REWRITE_SYSTEM_PROMPT, role: "system" },
          { content: buildQueryRewritePrompt(options.priorHistory ?? [], message), role: "user" }
        ],
        model: model ?? assembly.defaultModel ?? "default",
        responseFormat: QUERY_REWRITE_RESPONSE_FORMAT,
        temperature: 0
      });
      retrievalQuery = parseQueryRewrite(rewritten.output ?? "", message);
    } catch {
      retrievalQuery = message;
    }
  }
  const { block: groundingBlock, matches } = isCasual
    ? { block: "", matches: [] as Awaited<ReturnType<typeof retrieveChatGrounding>>["matches"] }
    : await retrieveChatGrounding(retrievalQuery);
  // Reply in the user's language: without this the local model drifts to English
  // for "assistant-y" replies — a Korean "회의 취소해줘" got an English "sir,
  // please provide…" ~2/3 of the time, jarring for a KO-primary companion. CRUCIAL
  // wording: a first/imperative "한국어로 답하세요" made the model emit Korean PROSE
  // instead of CALLING A TOOL (action tool-calling cratered 0/5). So the directive
  // (a) explicitly preserves tool use ("도구가 필요하면 평소처럼 호출하고"), scopes
  // the rule to the TEXT reply only, and (b) sits LAST, not first. With it: tool
  // calls 5/5 AND Korean 5/5. English turns get no directive (the model defaults
  // to English).
  const languageDirective = /[가-힣]/u.test(message)
    ? "사용자는 한국어를 씁니다. 도구 사용이 필요하면 평소처럼 도구를 호출하고, 사용자에게 보이는 텍스트 답변만 한국어로 작성하세요 (비밀번호·파일명·인용 출처 같은 고유값은 원문 그대로)."
    : "";
  const systemContent = [personaPreamble, userMemoryBlock, formatCurrentContextLine(), languageDirective]
    .filter((part) => part.length > 0)
    .join("\n\n") + groundingBlock;
  const messages = [
    { content: systemContent, role: "system" as const },
    ...(options.priorHistory ?? []),
    { content: message, role: "user" as const, ...(options.imageAttachments && options.imageAttachments.length > 0 ? { attachments: options.imageAttachments } : {}) }
  ];
  let result = await assembly.agentRuntime.run({
    messages,
    ...(hasMetadata ? { metadata } : {}),
    model: model ?? assembly.defaultModel ?? "default"
  });

  // qwen3:8b deterministically returns a BLANK completion (no text, no tool
  // call) for some "[time] [noun] 보여줘" phrasings — "오늘 할 일 보여줘" is empty
  // 8/8 while "할 일 보여줘" / "오늘 할 일 알려줘" answer fine. Re-asking with a
  // NEWLINE-led nudge breaks the degenerate stop (a space-join / punctuation
  // does NOT — only a newline). Recovers most; the empty-answer fallback floors
  // the rest. The retry's prompt is nudged but the answer is still gated against
  // the ORIGINAL message.
  if (result.response.output.trim().length === 0) {
    const nudge = /[가-힣]/u.test(message) ? "간단히 답해줘." : "Please answer briefly.";
    const retry = await assembly.agentRuntime.run({
      messages: [{ content: systemContent, role: "system" as const }, ...(options.priorHistory ?? []), { content: `${message}\n${nudge}`, role: "user" as const }],
      ...(hasMetadata ? { metadata } : {}),
      model: model ?? assembly.defaultModel ?? "default"
    });
    if (retry.response.output.trim().length > 0) result = retry;
  }

  // Honesty backstop — the continuous-session false "done". The model claims it
  // performed the action ("…일정이 추가되었습니다") but NO action tool ran. In a
  // running session, prior assistant turns that CLAIMED a done action poison the
  // history: the model reads them as "already done" and skips the tool while
  // still saying it acted (measured 1/8 real adds with a poisoned history vs 8/8
  // with a clean one). Re-run the action turn with NO prior history to clear the
  // poisoning, and keep the retry only when it ACTUALLY acted — never let an
  // unbacked "done" stand.
  if (requestsToolAction(message) && answerClaimsAction(result.response.output) && !actionToolRan(result.toolsUsed ?? [])) {
    const actNow = await assembly.agentRuntime.run({
      messages: [{ content: systemContent, role: "system" as const }, { content: message, role: "user" as const }],
      ...(hasMetadata ? { metadata } : {}),
      model: model ?? assembly.defaultModel ?? "default"
    });
    if (actionToolRan(actNow.toolsUsed ?? [])) result = actNow;
  }

  // Deterministic anti-fabrication gate: for a recall of the user's OWN data,
  // refuse honestly when the answer isn't grounded in the evidence (retrieved
  // notes/episodes + this conversation). The durable user-memory is handled by
  // the topic→stored-key check (knownFactKeys), and deliberately NOT folded into
  // the lexical evidence — doing so let a stored value satisfy ANY question and
  // whitewashed a cross-entity conflation ("the cat is 보리", the dog's name).
  const knownFactKeys = userMemory ? Object.keys(userMemory.facts ?? {}) : [];
  // Ask-parity escalation: when a model provider is available the borderline
  // bands get the same one-shot reverify judge ask uses (fires only on those
  // bands — the common grounded turn costs zero extra inference). Without a
  // provider the sync deterministic gate stands alone, as before. The whole
  // post-stream pipeline (gate → strips → receipt) is the SHARED
  // finalizeGatedChatAnswer so this surface and the Ink chat cannot drift.
  const chatProvider = assembly.modelProvider;
  const reverifyJudge = chatProvider && "generate" in chatProvider
    ? createQwenReverify(chatProvider, model ?? assembly.defaultModel ?? "default")
    : undefined;
  const withReceipt = await finalizeGatedChatAnswer({
    answer: result.response.output,
    history: options.priorHistory ?? [],
    knownFactKeys,
    matches,
    question: message,
    embed: defaultChatConflictEmbedder(),
    ...(reverifyJudge ? { reverify: reverifyJudge } : {}),
    toolsUsed: result.toolsUsed ?? [],
    toolGroundingSources: result.groundingSources ?? []
  });

  // Never hand the desktop a BLANK answer. qwen3:8b occasionally returns an empty
  // completion for a specific phrasing (observed deterministically on "오늘 할 일
  // 보여줘"), which surfaces as a blank chat bubble. Fall back to an honest retry
  // ask — better than silence, and not a deferral ("잠시만요…"), it admits the miss.
  const usedEmptyFallback = withReceipt.trim().length === 0;
  const response = usedEmptyFallback ? emptyAnswerFallback(message) : withReceipt;

  // "빨래 다 했어" — a past-tense REPORT of finishing a task. The model only acts
  // on the imperative ("완료로 표시해줘") and just acknowledges this, leaving the
  // task open. If the user reported a completion the model didn't act on, mark
  // the ONE matching open task done (reversible) and confirm it.
  let toolsUsed = result.toolsUsed ?? [];
  let finalResponse = response;
  if (isTaskCompletionReport(message) && !toolsUsed.some((tool) => tool.includes("tasks.complete"))) {
    const done = await autoCompleteReportedTask(message).catch(() => null);
    if (done) {
      toolsUsed = [...toolsUsed, "muse.tasks.complete"];
      finalResponse = `${response}\n\n${/[가-힣]/u.test(message) ? `✅ 할 일 '${done}'을(를) 완료로 표시했어요.` : `✅ Marked the task "${done}" as done.`}`;
    }
  }

  // If the answer STILL claims an action no tool performed (the re-run above also
  // didn't act), don't let the false "done" stand — admit it honestly so the
  // user knows nothing happened, matching the cited-recall edge ("I'm not sure"
  // over a confident fabrication).
  const unbackedAction = requestsToolAction(message) && answerClaimsAction(finalResponse) && !actionToolRan(toolsUsed);
  if (unbackedAction) {
    finalResponse = `${finalResponse}\n\n${/[가-힣]/u.test(message)
      ? "⚠️ 그런데 방금은 실제로 처리하지 못했어요. 한 번 더 말씀해 주시겠어요?"
      : "⚠️ Heads up — I didn't actually do that just now. Could you say it once more?"}`;
  }

  // Whetstone slice 1 — record the turn's failure signal to the weakness ledger
  // (detect → classify → persist). Fire-and-forget: a ledger write must never
  // break a turn. `unbacked-action` is always a true failure; a refusal is a
  // softer "couldn't answer" gap (may just be a missing note) — both are useful
  // self-knowledge. Casual turns never reach here as a failure.
  // Awaited (not fire-and-forget): a one-shot `chat --json` exits the moment
  // runLocalChat returns, so a dangling promise never flushes the ledger write.
  // recordChatWeakness swallows its own errors, so awaiting can't break the turn.
  if (unbackedAction) {
    await recordChatWeakness(message, "unbacked-action");
  } else if (!isCasual && (usedEmptyFallback || isChatAbstention(finalResponse) || looksLikeRefusal(finalResponse))) {
    const recorded = await recordChatWeakness(message, "grounding-gap");
    // Whetstone remediation (knowledge-gap nudge): a topic Muse has now failed to
    // answer 2+ times is a gap the USER can close — gently suggest a note. Only on
    // a repeat, so a one-off refusal stays clean. Reinforces the floor (it does
    // NOT push a guess), and points at the fix the user actually controls.
    if (recorded !== undefined && recorded >= 2) {
      finalResponse += /[가-힣]/u.test(message)
        ? "\n\n(이 주제는 전에도 여쭤보셨는데 제 노트엔 없어요. 관련 메모를 추가해두시면 다음엔 답해드릴 수 있어요.)"
        : "\n\n(You've asked about this before and it isn't in your notes yet — add a note and I'll be able to answer next time.)";
    }
  }

  return {
    response: finalResponse,
    runId: result.runId,
    toolsUsed
  };
}

// The explicit refusal phrases the grounding floor emits ("잘 모르겠어요" /
// "I'm not sure" / "no matching passages") — anchored on these, NOT a bare
// "not sure", so a normal answer that merely contains the words isn't logged.
const REFUSAL_RE = /잘\s*모르겠|모르겠어|관련(된|있는)?\s*(노트|메모|정보|내용)[^.]*없|찾(지|을)\s*(못했|수\s*없)|i'?m\s+not\s+sure|i\s+am\s+not\s+sure|no\s+matching\s+(passages|notes)|don'?t\s+have\s+(that|any)|couldn'?t\s+find/iu;

function looksLikeRefusal(text: string): boolean {
  return REFUSAL_RE.test(text);
}

/**
 * Append a failure signal to the Whetstone weakness ledger. @muse/mcp +
 * @muse/autoconfigure are loaded LAZILY — a static import of these heavy
 * modules breaks the bun-compiled desktop binary (top-level await in a sync
 * context). Best-effort; swallows every error.
 */
async function recordChatWeakness(message: string, axis: "grounding-gap" | "unbacked-action"): Promise<number | undefined> {
  try {
    const { recordWeakness } = await import("@muse/mcp");
    const { resolveWeaknessesFile } = await import("@muse/autoconfigure");
    const file = resolveWeaknessesFile(process.env as Record<string, string | undefined>);
    const entry = await recordWeakness(file, { axis, message });
    return entry?.count;
  } catch {
    // a ledger write must never surface as a chat error
    return undefined;
  }
}

/**
 * Mark the single open task a completion report names as done (reversible).
 * Returns the completed task's title, or null when nothing matched or it was
 * ambiguous. The @muse/mcp store is a HEAVY async-init module, so it is loaded
 * lazily here — a STATIC import would break the bun-compiled desktop binary.
 */
async function autoCompleteReportedTask(message: string): Promise<string | null> {
  const { readTasks, writeTasks } = await import("@muse/mcp");
  const file = resolveTasksFile(process.env as Record<string, string | undefined>);
  const tasks = await readTasks(file);
  const openTasks = tasks.filter((task) => task.status === "open");
  const index = matchCompletedTask(message, openTasks.map((task) => task.title));
  if (index === null) return null;
  const target = openTasks[index]!;
  const completedAt = new Date().toISOString();
  await writeTasks(file, tasks.map((task) => task.id === target.id ? { ...task, status: "done" as const, completedAt } : task));
  return target.title;
}

/** Honest stand-in when the model returns a blank completion — never a blank bubble. */
export function emptyAnswerFallback(message: string): string {
  return /[가-힣]/u.test(message)
    ? "방금은 답을 제대로 만들지 못했어요. 한 번만 다시, 조금 다르게 말씀해 주시겠어요?"
    : "I didn't manage to put that answer together — could you say it once more, maybe a little differently?";
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

