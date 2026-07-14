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

import { createMuseRuntimeAssembly, resolveTasksFile } from "@muse/autoconfigure";
import type { Command } from "commander";

import { classifyCasualPrompt, isUnbackedActionClaim, runResistingFalseDone, type AgentRunResult, type KnowledgeMatch } from "@muse/agent-core";
import type { ModelProvider } from "@muse/model";

import { buildQueryRewritePrompt, chatTraceOutcome, defaultChatConflictEmbedder, factKeysToInject, finalizeGatedChatAnswer, isChatAbstention, isChatGroundedSuccess, needsContextualRewrite, parseQueryRewrite, QUERY_REWRITE_RESPONSE_FORMAT, QUERY_REWRITE_SYSTEM_PROMPT, retrieveChatGrounding } from "./chat-grounding.js";
import { createQwenReverify } from "./grounding-eval-runner.js";
import { isRecord } from "./credential-store.js";
import { buildMusePersona, formatCurrentContextLine } from "@muse/recall";
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
import { resolveChatFastPath } from "./chat-fast-path.js";
import type { ProgramIO } from "./program.js";

// The deterministic fast-path renderers moved to a sibling module; re-export the
// public ones so chat-repl's surface (and its tests) stay stable.
export { formatNotesOverview, formatReminderList, formatTaskList } from "./chat-fast-path-format.js";

// Privacy-tiered cloud routing moved to a sibling module (behavior-preserving
// decomposition, no code changes); re-export so existing importers of
// `chat-repl.js` (chat-ink-run.ts, the privacy-routing tests) keep working.
import { createChatCloudTurn, filterFactsToKeys } from "./chat-cloud-routing.js";
export { buildCloudTurnRequest, chatHasPersonalContext, createChatCloudTurn, filterFactsToKeys, formatCloudRouteMarker, resolveChatRouting } from "./chat-cloud-routing.js";

// Whetstone weakness-ledger recording moved to a sibling module (behavior-preserving
// decomposition, no code changes); re-export so existing importers of
// `chat-repl.js` (chat-ink-run.ts, the weakness-ledger tests) keep working.
import { chatRepeatWeaknessNudge, chatResolveWeakness, looksLikeRefusal, recordChatWeaknessForTurn } from "./chat-weakness-ledger.js";
export { chatRepeatWeaknessNudge, chatResolveWeakness, recordChatWeaknessForTurn, recordChatTurnWeakness, type ChatRepeatNudgeDeps, type RecordChatWeaknessDeps, type ResolveChatWeaknessDeps } from "./chat-weakness-ledger.js";

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
      // fuel that previously vanished (the run-log was happy-path only).
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

/**
 * One chat turn → one run-log trace, outcome-labelled (`grounded`) the same way
 * for EVERY chat surface. The single-turn path gets this via
 * `createTuiChatSubmitter`; the interactive Ink session calls it from its
 * finalize step (before this, Ink turns wrote NO trace — the most-used surface
 * produced zero error-analysis fuel). Casual turns assert no claim → grounded
 * stays null. Best-effort by contract: a logging failure never disturbs the turn.
 */
export async function recordChatTurnTrace(
  args: {
    readonly question: string;
    readonly answer: string;
    readonly matches: readonly KnowledgeMatch[];
    readonly model?: string;
    readonly source: "cli.local" | "cli.ink";
    readonly workspaceDir?: string;
  },
  write: typeof writeRunLog = writeRunLog
): Promise<void> {
  const isCasual = classifyCasualPrompt(args.question) !== null;
  // Same two-detector refusal check the single-turn path uses (isChatAbstention
  // catches the gate's own phrasing; REFUSAL_RE catches the model's).
  const refusal = isChatAbstention(args.answer) || looksLikeRefusal(args.answer);
  await write(args.workspaceDir ?? process.cwd(), {
    message: args.question,
    ...(args.model !== undefined ? { model: args.model } : {}),
    response: {
      grounded: isCasual ? null : chatTraceOutcome({ answer: args.answer, matches: args.matches, refusal, unbackedAction: false }),
      response: args.answer,
      success: true
    },
    source: args.source
  }).catch(() => undefined);
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
    /**
     * Test seam for privacy-tiered routing's cloud leg — production defaults
     * to `createModelProviderFor`. Injected so a test can assert what a
     * cloud-routed turn actually SENDS without a live API key/network.
     */
    readonly cloudProviderFactory?: (model: string, env: Readonly<Record<string, string | undefined>>) => ModelProvider | undefined;
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

  // Deterministic fast-paths (meta / corpus / tasks / reminders / contacts /
  // arithmetic / date / countdown / date-diff / timezone) short-circuit BEFORE
  // any model call — each returns the uniform `{ response, runId, toolsUsed }`
  // shape, or `undefined` to fall through to grounded recall below.
  const fastPath = await resolveChatFastPath(message);
  if (fastPath) {
    return fastPath;
  }

  // A bare greeting / social prompt never needs a tool — but projecting the tool
  // schemas into the prompt is what made even "안녕" take ~22s (qwen3:8b's
  // prompt-eval on the big tool block). Detect it deterministically and drop the
  // tools, taking that turn from ~22s to ~2s (measured) with no capability loss.
  const isCasual = classifyCasualPrompt(message) !== null;
  const metadata: Record<string, string | number | boolean> = {};
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

  // System content grounds the model in `now`, the base persona, AND what Muse
  // durably knows about the user (name, language preference, …). Loading the
  // user memory here — like the REPL does — is what lets the desktop chat answer
  // "what's my name?" and honour the stored response-language preference across
  // sessions, instead of forgetting everything the moment the conversation resets.
  const userId = resolveDefaultUserKey({});
  const userMemoryStore = assembly.userMemoryStore;
  const userMemory = userMemoryStore
    ? await Promise.resolve(userMemoryStore.findByUserId(userId)).catch(() => undefined)
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
  // Fact-caution parity with `muse ask`: flag a persona fact that is volatile
  // (contested) or once-seen-unconfirmed (provisional) so chat cautions it at
  // point-of-use instead of asserting it. Lazy import — the heavy @muse/memory store
  // breaks the bun-compiled desktop binary on a static import. Fail-soft: any error
  // ⇒ no sets ⇒ unmarked persona, the same posture ask falls back to.
  let personaContestedKeys: ReadonlySet<string> = new Set();
  let personaProvisionalKeys: ReadonlySet<string> = new Set();
  let personaStaleKeys: ReadonlySet<string> = new Set();
  if (personaMemory && Object.keys(personaMemory.facts).length > 0) {
    try {
      const { FileBeliefProvenanceStore, defaultBeliefProvenanceFile, deriveFactProvenance, contestedFactKeys, provisionalFactKeys, staleFactKeys, normalizeMemoryKey } = await import("@muse/memory");
      const { isMemoryInjection } = await import("@muse/agent-core");
      const personaFactKeys = Object.keys(personaMemory.facts);
      const provenance = deriveFactProvenance(await new FileBeliefProvenanceStore(defaultBeliefProvenanceFile()).query(userId));
      const nowMs = Date.now();
      personaProvisionalKeys = provisionalFactKeys(personaFactKeys, provenance, { isInjection: isMemoryInjection, normalizeKey: normalizeMemoryKey, now: nowMs });
      personaContestedKeys = contestedFactKeys(personaFactKeys, provenance, { normalizeKey: normalizeMemoryKey, now: nowMs });
      personaStaleKeys = staleFactKeys(personaFactKeys, provenance, { normalizeKey: normalizeMemoryKey, now: nowMs });
    } catch { /* provenance unavailable — render the persona without the marks */ }
  }
  const userMemoryBlock = personaMemory
    ? (buildMusePersona(personaMemory, userId, { contestedKeys: personaContestedKeys, provisionalKeys: personaProvisionalKeys, staleKeys: personaStaleKeys }) ?? "").trim()
    : "";
  // The persona block below is hand-injected into `systemContent` (the run's
  // system message), so flag the run to STOP the runtime re-injecting its own
  // user-memory section — the buildMusePersona block already carries it (typed
  // model + defense line included). Set ONLY when a persona is actually present:
  // an empty block means no learned data was injected, so the runtime's section
  // (also empty) must be allowed to run rather than skipped (no hole).
  if (userMemoryBlock.length > 0) metadata.personaPreinjected = true;
  const hasMetadata = Object.keys(metadata).length > 0;
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

  // Privacy-tiered routing (off by default): a request carrying NO persona,
  // grounding, or PII signal MAY be routed to `MUSE_CLOUD_MODEL` instead of
  // the local default; any personal signal keeps it local, unconditionally.
  // `buildCloudTurnRequest` cannot forward `systemContent` (persona +
  // grounding) or `options.priorHistory` — a cloud-routed turn sees only the
  // raw message, structurally, not by a runtime check.
  const routingDefaultModel = model ?? assembly.defaultModel ?? "default";
  const cloudTurn = createChatCloudTurn({
    cloudProviderFactory: options.cloudProviderFactory,
    defaultModel: routingDefaultModel,
    env: process.env,
    memoryFacts: () => userMemory?.facts
  });
  const cloudResult = await cloudTurn(message, userMemoryBlock, groundingBlock);

  let result: AgentRunResult | undefined = cloudResult
    ? { response: cloudResult.response, runId: cloudResult.response.id }
    : undefined;
  const cloudMarker = cloudResult?.marker;

  if (!result) {
    const messages = [
      { content: systemContent, role: "system" as const },
      ...(options.priorHistory ?? []),
      { content: message, role: "user" as const, ...(options.imageAttachments && options.imageAttachments.length > 0 ? { attachments: options.imageAttachments } : {}) }
    ];
    result = await assembly.agentRuntime.run({
      messages,
      ...(hasMetadata ? { metadata } : {}),
      model: routingDefaultModel
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
        model: routingDefaultModel
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
    const agentRuntime = assembly.agentRuntime;
    result = await runResistingFalseDone({
      query: message,
      firstResult: result,
      retry: () => agentRuntime.run({
        messages: [{ content: systemContent, role: "system" as const }, { content: message, role: "user" as const }],
        ...(hasMetadata ? { metadata } : {}),
        model: routingDefaultModel
      })
    });
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
  // `.display` (answer + receipt + source-check cues) is what this one-shot surface
  // PRINTS; `.forHistory` (cue-free) is what the caller PERSISTS via appendLastChatTurn,
  // so the display-only source-check warnings aren't replayed as trusted grounding
  // evidence on the next session's priorHistory (parity with the Ink chat).
  const finalized = await finalizeGatedChatAnswer({
    answer: result.response.output,
    history: options.priorHistory ?? [],
    knownFactKeys,
    memories: userMemory ? Object.entries(userMemory.facts ?? {}).map(([key, value]) => ({ key, value })) : [],
    matches,
    question: message,
    embed: defaultChatConflictEmbedder(),
    ...(reverifyJudge ? { reverify: reverifyJudge } : {}),
    toolsUsed: result.toolsUsed ?? [],
    toolGroundingSources: result.groundingSources ?? []
  });
  const withReceipt = finalized.display;
  const withReceiptForHistory = finalized.forHistory;

  // Never hand the desktop a BLANK answer. qwen3:8b occasionally returns an empty
  // completion for a specific phrasing (observed deterministically on "오늘 할 일
  // 보여줘"), which surfaces as a blank chat bubble. Fall back to an honest retry
  // ask — better than silence, and not a deferral ("잠시만요…"), it admits the miss.
  const usedEmptyFallback = withReceipt.trim().length === 0;
  const response = usedEmptyFallback ? emptyAnswerFallback(message) : withReceipt;
  // The persisted twin tracks `response` through the REAL-content transforms below
  // (fallback, task-completion, unbacked-action self-correction), but excludes the
  // display-only affordances appended to `finalResponse` for the user: the source-check
  // cues `finalized.forHistory` already dropped AND the repeat-weakness
  // nudge added later — neither is conversational content, so neither may be replayed
  // as trusted grounding evidence on the next session's priorHistory.
  const responseForHistory = usedEmptyFallback ? emptyAnswerFallback(message) : withReceiptForHistory;

  // "빨래 다 했어" — a past-tense REPORT of finishing a task. The model only acts
  // on the imperative ("완료로 표시해줘") and just acknowledges this, leaving the
  // task open. If the user reported a completion the model didn't act on, mark
  // the ONE matching open task done (reversible) and confirm it.
  let toolsUsed = result.toolsUsed ?? [];
  let finalResponse = response;
  let finalResponseForHistory = responseForHistory;
  if (isTaskCompletionReport(message) && !toolsUsed.some((tool) => tool.includes("tasks.complete"))) {
    const done = await autoCompleteReportedTask(message).catch(() => null);
    if (done) {
      toolsUsed = [...toolsUsed, "muse.tasks.complete"];
      // Real conversational content (a completion confirmation) — append to BOTH tracks.
      const confirmation = `\n\n${/[가-힣]/u.test(message) ? `✅ 할 일 '${done}'을(를) 완료로 표시했어요.` : `✅ Marked the task "${done}" as done.`}`;
      finalResponse = `${response}${confirmation}`;
      finalResponseForHistory = `${responseForHistory}${confirmation}`;
    }
  }

  // If the answer STILL claims an action no tool performed (the re-run above also
  // didn't act), don't let the false "done" stand — admit it honestly so the
  // user knows nothing happened, matching the cited-recall edge ("I'm not sure"
  // over a confident fabrication).
  const unbackedAction = isUnbackedActionClaim({ query: message, answer: finalResponse, toolNames: toolsUsed });
  if (unbackedAction) {
    // A self-correction the user must see AND that belongs in the resumed conversation
    // (it changes what Muse claimed) — append to BOTH tracks.
    const heads = `\n\n${/[가-힣]/u.test(message)
      ? "⚠️ 그런데 방금은 실제로 처리하지 못했어요. 한 번 더 말씀해 주시겠어요?"
      : "⚠️ Heads up — I didn't actually do that just now. Could you say it once more?"}`;
    finalResponse = `${finalResponse}${heads}`;
    finalResponseForHistory = `${finalResponseForHistory}${heads}`;
  }

  // Record the turn's failure signal to the weakness ledger
  // (detect → classify → persist). Fire-and-forget: a ledger write must never
  // break a turn. `unbacked-action` is always a true failure; a refusal is a
  // softer "couldn't answer" gap (may just be a missing note) — both are useful
  // self-knowledge. Casual turns never reach here as a failure.
  // Awaited (not fire-and-forget): a one-shot `chat --json` exits the moment
  // runLocalChat returns, so a dangling promise never flushes the ledger write.
  // recordChatWeakness swallows its own errors, so awaiting can't break the turn.
  // Whetstone classify→persist with ASK parity: `unbacked-action` > `misgrounding`
  // (a non-refusal answer whose cited sources don't actually support it —
  // GROUNDED != TRUE, the most-used surface was previously BLIND to it) >
  // `grounding-gap` (a refusal/empty-fallback). A fully-supported grounded answer
  // writes nothing. Casual turns never reach here as a failure.
  const chatRefusal = usedEmptyFallback || isChatAbstention(finalResponse) || looksLikeRefusal(finalResponse);
  if (unbackedAction) {
    await recordChatWeaknessForTurn({ message, answer: finalResponse, matches, refusal: chatRefusal, unbackedAction });
  } else if (!isCasual) {
    await recordChatWeaknessForTurn({ message, answer: finalResponse, matches, refusal: chatRefusal, unbackedAction });
    // Parity with ask's recordAskWeaknessResolvedLive: a GROUNDED SUCCESS on this
    // topic resolves its grounding-gap (BKT mastery) so a now-answered recurring
    // gap stops nudging. Gated on a genuine grounded answer (axis null + real
    // evidence) — never a refusal/misgrounding/unbacked action.
    if (isChatGroundedSuccess({ answer: finalResponse, matches, refusal: chatRefusal, unbackedAction })) {
      await chatResolveWeakness(message);
    }
    // Whetstone learn→apply at point-of-use: if THIS topic is already a recurring
    // user-remediable weakness in the shared ledger, surface the SAME axis-aware
    // hint the `ask` 💡 cue uses (grounding-gap "add a note" OR source-conflict
    // "reconcile your notes" — the latter the old chat nudge could never show),
    // mastery-suppressed, never on a dev-fixable misgrounding. Unified onto the
    // shared helper so chat/ask wording can't drift.
    const nudge = await chatRepeatWeaknessNudge(message);
    if (nudge) finalResponse += nudge;
  }

  // "Shows its work" for a cloud-routed turn — display-only (never persisted
  // to `finalResponseForHistory`, matching every other cue above) so the next
  // session's `priorHistory` never carries the marker as if it were content.
  if (cloudMarker) {
    finalResponse += cloudMarker;
  }

  return {
    response: finalResponse,
    // Outcome label for the run-log trace (writeRunLog lifts `grounded` to the top
    // level) so a chat MISGROUNDING becomes error-analysis FUEL instead of a
    // grounded:null happy-path row — parity with the ask path. Casual turns assert
    // no claim, so they carry no grounding verdict.
    grounded: isCasual ? null : chatTraceOutcome({ answer: finalResponse, matches, refusal: chatRefusal, unbackedAction }),
    // The cue-free twin for persistence (appendLastChatTurn) — keeps display-only
    // source-check warnings out of the next session's grounding evidence.
    responseForHistory: finalResponseForHistory,
    // Whether this answer rested on untrusted-only sources — persisted per-turn so a
    // later episode capture marks the episode trusted:false even for this one-shot
    // turn the live REPL never saw (episode-laundering defense, EP-1b / MemoryGraft).
    untrustedOnly: finalized.untrustedOnly,
    runId: result.runId,
    toolsUsed
  };
}

/**
 * Mark the single open task a completion report names as done (reversible).
 * Returns the completed task's title, or null when nothing matched or it was
 * ambiguous. The @muse/mcp store is a HEAVY async-init module, so it is loaded
 * lazily here — a STATIC import would break the bun-compiled desktop binary.
 */
async function autoCompleteReportedTask(message: string): Promise<string | null> {
  const { readTasks, writeTasks } = await import("@muse/stores");
  const file = resolveTasksFile(process.env);
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

function readChatResponseText(value: unknown): string {
  if (isRecord(value) && typeof value.response === "string") {
    return value.response;
  }

  if (isRecord(value) && typeof value.content === "string") {
    return value.content;
  }

  return JSON.stringify(value);
}

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
