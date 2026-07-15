/**
 * Runtime wiring for the Ink chat surface: build the local runtime assembly,
 * the memory / contested-fact holders, the stream + streamWithTools adapters,
 * the save/copy/recall/reflect/today/jobs provider closures, render MuseChatApp,
 * and run the end-of-session distillation pipeline on exit. The render tree
 * (MuseChatApp) lives in chat-ink.ts; render-free logic lives in chat-ink-core.ts.
 */

import { buildContextWindowOptions, createMuseRuntimeAssembly, evaluateLocalOnlyPosture, parseBoolean, resolveEpisodesFile, resolveFollowupsFile, resolveLocalCalendarFile, resolvePatternsFiredFile, resolveRemindersFile, resolveTasksFile } from "@muse/autoconfigure";
import { LocalCalendarProvider } from "@muse/calendar";
import { isSkillAvoided, readEpisodes, readFollowups, readPatternsFired, readSkillRewards, readTasks, type ConversationSummary } from "@muse/stores";
import { readCheckins } from "@muse/proactivity";
import { aggregateActivitySignals, contestedFactKeys, defaultBeliefProvenanceFile, deriveFactProvenance, FileBeliefProvenanceStore, normalizeMemoryKey, recordRetraction, selectFireablePatterns } from "@muse/memory";
import { AuthoredSkillStore, loadSkillsFromDirectory, type Skill } from "@muse/skills";
import { render } from "ink";
import { spawn } from "node:child_process";
import { mkdir, readFile as fsReadFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import React from "react";



import { createModelDroppedContextSummarizer, detectUserCommitments } from "@muse/agent-core";

import { activeConversationId, appendActivity, appendLastChatTurn, appendSessionBoundary, listConversations, maybeCompactLastChatHistory, readLastChatHistory, resumeConversation, startNewConversation, type LastChatLine } from "./chat-history.js";
import {
  buildRecap,
  chatToolApprovalGate,
  createContextualGroundingLookup,
  hasCloudCredential,
  providerIdFromModel,
  readImageAttachment,
  formatNoModelMessage,
  formatRecallHits,
  recurringEpisodeThreads,
  resolveChatHistoryWindow,
  type ChatTurnMessage,
  type JobListItem,
  type MemorySnapshot,
  type ResumeConversationResult
} from "./chat-ink-core.js";
import { buildSkillsPrompt } from "./chat-skills.js";
import { resolveSkillRewardsFile } from "./commands-skills.js";
import { selectPersonaEpisodes } from "./episode-selection.js";
import { MuseChatApp, OUTBOUND_ACTUATORS, PROACTIVE_LEAD_MS, type RunChatInkOptions } from "./chat-ink.js";
import { renderMuseBanner } from "./muse-banner.js";
import { loadAgents, resolveAgentsDir, type AgentDef } from "./commands-agents.js";
import { createChatCloudTurn, recordChatTurnTrace, recordChatTurnWeakness } from "./chat-repl.js";
import {
  buildQueryRewritePrompt,
  defaultChatConflictEmbedder,
  finalizeGatedChatAnswer,
  parseQueryRewrite,
  QUERY_REWRITE_RESPONSE_FORMAT,
  QUERY_REWRITE_SYSTEM_PROMPT,
  retrieveChatGrounding
} from "./chat-grounding.js";
import { createQwenReverify } from "./grounding-eval-runner.js";
import { searchRecall } from "./commands-recall.js";
import { readTrust } from "./commands-trust.js";
import { appendInputHistory, loadInputHistory } from "./chat-input-history.js";
import { appendPlaybookInjection, forwardRecordingInjections } from "./playbook-injections.js";
import { applyTurnLearnings, extractMemoryFromTurn, shouldAutoExtract, type AutoMemoryProvider } from "./chat-auto-memory.js";
import { buildModelGroundingReverify, formatReflection, synthesizeReflection, type ReflectionProvider } from "./chat-reflection.js";
import { listRecentJobIds, readJobSummary, startBackgroundJob } from "./commands-jobs.js";
import { createChatOrchestration, orchestrationCompletionsFrom } from "./chat-orchestrate.js";
import { buildLocalTodayText, parseLookaheadHours, readDueFollowups, readDueReminders } from "./commands-today.js";
import { calendarEventItems, checkinItems, dueTaskItems, jobCompletionItems, patternSuggestionItems, type ProactiveItem } from "./chat-proactive.js";
import { checkinsFile } from "./commands-checkins.js";
import { buildMusePersona } from "@muse/recall";
import { resolvePersona } from "./program-helpers.js";
import { idleLearnedNoticeForUser } from "./commands-learned.js";
import { resolveDefaultUserKey } from "./user-id.js";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";
import { runEndOfSessionPipeline } from "./chat-end-session-pipeline.js";
import { beginSessionWithCrashCheck, endSessionClean, sessionMarkerPath } from "./session-recovery.js";
import { withBestEffort } from "./async-promises.js";

const h = React.createElement;

/**
 * Build the local runtime and drive the Ink chat to completion. Prior
 * turns feed the model for memory but are NOT shown (clean entry like
 * `claude`); the transcript scrolls above the box as you chat.
 */
export async function runChatInk(options: RunChatInkOptions = {}): Promise<void> {
  const continueHistory = options.continueHistory !== false;
  if (options.model && !process.env.MUSE_MODEL) process.env.MUSE_MODEL = options.model;
  if (options.model?.startsWith("ollama/") && !process.env.MUSE_MODEL_PROVIDER_ID) {
    process.env.MUSE_MODEL_PROVIDER_ID = "ollama";
  }

  const assembly = createMuseRuntimeAssembly();
  if (!assembly.modelProvider) {
    process.stderr.write(formatNoModelMessage());
    process.exitCode = 1;
    return;
  }
  const model = options.model ?? assembly.defaultModel ?? "default";
  const baseUser = resolveDefaultUserKey({ override: options.userId });
  const personaSlot = resolvePersona(options.persona);
  const userId = personaSlot && personaSlot.length > 0 ? `${baseUser}@${personaSlot}` : baseUser;
  const memoryStore = assembly.userMemoryStore;
  // Mutable holder so /forget and /remember take effect on the NEXT turn's
  // persona — otherwise the system prompt keeps injecting a fact the user just
  // dropped (what /memory shows would diverge from what's actually injected).
  const memoryHolder: { current: Awaited<ReturnType<NonNullable<typeof memoryStore>["findByUserId"]>> | undefined } = {
    current: memoryStore ? await memoryStore.findByUserId(userId) : undefined
  };
  // Contested-fact caution on the CHAT persona (parity with ask's grounding block):
  // a fact whose value FLIPPED across confirmations is volatile, so the persona must
  // say "confirm it's current" instead of asserting a value Muse itself knows is
  // unstable. Derived from the belief-provenance store, refreshed alongside memory.
  // Best-effort (fail-soft to no caution, like ask).
  const contestedHolder: { current: ReadonlySet<string> } = { current: new Set() };
  const refreshContestedKeys = async (): Promise<void> => {
    const keys = memoryHolder.current ? Object.keys(memoryHolder.current.facts) : [];
    if (keys.length === 0) { contestedHolder.current = new Set(); return; }
    try {
      const provenance = deriveFactProvenance(await new FileBeliefProvenanceStore(defaultBeliefProvenanceFile()).query(userId));
      contestedHolder.current = contestedFactKeys(keys, provenance, { normalizeKey: normalizeMemoryKey, now: Date.now() });
    } catch { contestedHolder.current = new Set(); }
  };
  const refreshMemory = async (): Promise<void> => {
    if (memoryStore) memoryHolder.current = await memoryStore.findByUserId(userId);
    await refreshContestedKeys();
  };
  await refreshContestedKeys();
  // Episodic memory in the persona: the most recent episodes for this user
  // ride into the system prompt so Muse recalls past sessions, not just the
  // last-chat tail. Best-effort (missing/corrupt episodes file → none).
  const personaEpisodes = await withBestEffort(loadPersonaEpisodes(userId), []);
  const recurringThreads = recurringEpisodeThreads(personaEpisodes);
  const personaPrompt = (): string | undefined =>
    memoryHolder.current ? buildMusePersona({ ...memoryHolder.current, episodes: personaEpisodes, recurringThreads }, userId, { contestedKeys: contestedHolder.current }) : undefined;

  // Long-session compaction: if the active conversation has grown past the
  // threshold, summarise the old turns into one line before seeding — so a
  // multi-day continuous relationship doesn't blow the context window
  // ("doesn't forget; it abstracts"). Best-effort; falls through on any failure.
  if (continueHistory && assembly.modelProvider) {
    try {
      await maybeCompactLastChatHistory(
        assembly.modelProvider as Parameters<typeof maybeCompactLastChatHistory>[0],
        model
      );
    } catch { /* compaction is best-effort */ }
  }

  // Shared by the boot-time seed AND `/resume` (which reloads context mid-REPL
  // after switching the active conversation) — both want the SAME window.
  // Returns the raw (unsliced, ≤24-turn) lines too — the launch recap's
  // open-commitment detection below wants the full window, not just the
  // last 20 the model context keeps.
  const seedChatHistory = async (): Promise<{ readonly lines: readonly LastChatLine[]; readonly messages: ChatTurnMessage[] }> => {
    const lines = await withBestEffort(readLastChatHistory(), []);
    const messages = lines
      .filter((l) => l.role === "user" || l.role === "assistant")
      .map((l) => ({ content: l.content, role: l.role as "user" | "assistant" }))
      .slice(-20);
    return { lines, messages };
  };
  const bootSeed = continueHistory ? await seedChatHistory() : { lines: [], messages: [] };
  const seedLines = bootSeed.lines;
  const history: ChatTurnMessage[] = bootSeed.messages;

  // Shell-style ↑/↓ input history across sessions.
  const inputHistorySeed = await withBestEffort(loadInputHistory(), [] as string[]);

  // Mark the session start: an activity event (routine learning) + a boundary
  // sentinel in last-chat.jsonl. The boundary tells the end-of-session episode
  // extractor which turns belong to THIS session (read on exit, below).
  await withBestEffort(appendActivity({ kind: "repl-start", userId }), undefined);
  await withBestEffort(appendSessionBoundary({ tsIso: new Date().toISOString(), userId }), undefined);
  // SES crash-recovery: detect a prior session that never reached its clean
  // end (marker survived) and record this start. The turns are already
  // durable in last-chat.jsonl, so a prior crash is a notice, not data loss.
  const sesMarker = sessionMarkerPath();
  const priorCrash = await withBestEffort(beginSessionWithCrashCheck(sesMarker, { pid: process.pid, startedAt: new Date().toISOString() }), undefined);
  if (priorCrash) {
    process.stderr.write("(note: the previous Muse session didn't close cleanly — your last messages were preserved)\n");
  }

  const provider = assembly.modelProvider;
  type ChatStream = AsyncIterable<{ type: string; text?: string; error?: unknown; name?: string; response?: { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }>;
  type ProviderMessage = {
    readonly role: ChatTurnMessage["role"];
    readonly content: string;
    readonly attachments?: { readonly mimeType: string; readonly dataBase64: string }[];
  };
  const toProviderMessages = (messages: readonly ChatTurnMessage[]): readonly ProviderMessage[] =>
    messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.attachments ? { attachments: [...message.attachments] } : {})
    }));
  const stream = (messages: readonly ChatTurnMessage[], useModel: string): ChatStream =>
    provider.stream({ messages: toProviderMessages(messages), model: useModel });

  // Privacy-tiered routing parity with `runLocalChat`: the routing decision +
  // cloud leg live in `createChatCloudTurn` (chat-repl.ts) — MuseChatApp calls
  // this per turn AHEAD of building the persona/grounding-aware message list,
  // so a context-free turn never reaches `stream`/`streamWithTools` at all.
  const cloudTurnLeg = createChatCloudTurn({
    defaultModel: model,
    env: process.env,
    memoryFacts: () => memoryHolder.current?.facts
  });
  const cloudTurn = async (message: string, personaBlock: string, groundingBlock: string) => {
    const cloud = await cloudTurnLeg(message, personaBlock, groundingBlock);
    return cloud ? { marker: cloud.marker, text: cloud.response.output } : undefined;
  };

  // Tools-on path: route through the agent runtime so the tool loop + guards
  // fire. Outbound actuators stay forbidden (no autonomous third-party send);
  // read tools + local writes run. Falls back to plain stream if no runtime.
  const agentRuntime = assembly.agentRuntime;
  const streamWithTools = (
    messages: readonly ChatTurnMessage[],
    useModel: string,
    requestApproval: (toolName: string, detail: string, kind: "outbound" | "tool") => Promise<boolean>
  ): ChatStream => {
    if (!agentRuntime) return stream(messages, useModel);
    const events = agentRuntime.stream({
      messages: toProviderMessages(messages),
      // `localMode` exposes execute-risk tools (email/web/home actuators, shell)
      // to the chat model; the fail-closed gate below is what keeps them safe —
      // every write/execute call must be confirmed by the user with its content
      // shown, reads run silently, and a denial / gate error blocks the call
      // (runtime fail-close). This is the in-chat "act" path per outbound-safety.md.
      // NOTE: this path deliberately does NOT set `personaPreinjected`. The runtime
      // auto-extract hook writes to the store mid-session, and the persona source
      // (`memoryHolder.current`) is only refreshed at start / on autoLearn / on a
      // slash command — so skipping the runtime's fresh per-turn re-read would drop
      // a just-learned fact (breaks the auto-extract-refresh contract, fable review).
      // The hand-injected persona + the runtime section is a benign content-complete
      // redundancy here; the real de-dup is routing this path through the runtime
      // (a separate slice), not a stale-persona skip.
      metadata: { localMode: true, userId },
      model: useModel,
      toolApprovalGate: chatToolApprovalGate(OUTBOUND_ACTUATORS, requestApproval)
    });
    // Record which playbook strategies this turn's prompt carried so the
    // end-of-session reward step credits an actually-injected strategy
    // (fail-soft: a failed append never disturbs the stream).
    return forwardRecordingInjections(events, (ids) => {
      void withBestEffort(appendPlaybookInjection({ ids, tsIso: new Date().toISOString(), userId }), undefined);
    }) as ChatStream;
  };

  // `@path` attachments: read relative to the launch directory, fail-soft,
  // capped so a huge file can't blow the context window.
  const readFile = async (relativePath: string): Promise<string | undefined> => {
    try {
      const abs = isAbsolute(relativePath) ? relativePath : join(process.cwd(), relativePath);
      const body = await fsReadFile(abs, "utf8");
      return body.length > 8000 ? `${body.slice(0, 8000)}\n…(truncated)` : body;
    } catch {
      return undefined;
    }
  };

  const readImage = (relativePath: string) => readImageAttachment(relativePath);

  // /save → write the reply to ~/.muse/chat-saves/<ts>.md
  const saveText = async (text: string): Promise<string | undefined> => {
    try {
      const dir = join(homedir(), ".muse", "chat-saves");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/gu, "-")}.md`);
      await writeFile(file, `${text}\n`, "utf8");
      return file;
    } catch {
      return undefined;
    }
  };
  // /copy → pipe the reply to the platform clipboard tool.
  const copyToClipboard = (text: string): Promise<boolean> => {
    const cmd = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip";
    const args = process.platform === "linux" ? ["-selection", "clipboard"] : [];
    const { promise, resolve } = Promise.withResolvers<boolean>();
    try {
      const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
      proc.stdin.end(text);
    } catch {
      resolve(false);
    }
    return promise;
  };

  const onCommit = (user: string, assistant: string, untrusted?: boolean): void => {
    void withBestEffort(appendLastChatTurn({ message: user, response: assistant, responseUntrusted: untrusted }), undefined);
  };

  // Background auto-memory: after a turn, quietly learn durable facts the user
  // stated in passing — no "remember this" needed. Cooldown-gated so the snappy
  // reply path isn't slowed; returns a short summary of what was newly stored so
  // the chat can surface it (the user sees it + can /forget). Opt out with
  // MUSE_USER_MEMORY_AUTO_EXTRACT=false.
  const autoMemoryEnabled = memoryStore !== undefined
    && parseBoolean(process.env.MUSE_USER_MEMORY_AUTO_EXTRACT, true)
    && "generate" in provider;
  const lastExtract = { current: undefined as number | undefined };
  const autoLearn = async (user: string, assistant: string): Promise<string | undefined> => {
    if (!autoMemoryEnabled || assistant.trim().length === 0) return undefined;
    const now = Date.now();
    if (!shouldAutoExtract(lastExtract.current, now)) return undefined;
    lastExtract.current = now;
    try {
      const { facts, preferences } = await extractMemoryFromTurn({
        assistant, model, provider: provider as AutoMemoryProvider, user
      });
      const { summary, confirmation } = await applyTurnLearnings(memoryStore!, userId, facts, preferences);
      // The cited "Got it — X is now Y (changed from Z)" confirmation for a
      // correction, plus the plain "remembered" summary for newly-learned keys.
      const line = [confirmation, summary].filter((part): part is string => Boolean(part)).join("\n");
      if (line.length > 0) await refreshMemory();
      return line.length > 0 ? line : undefined;
    } catch {
      return undefined;
    }
  };
  // Session-level source-trust verdict, bridged from the component (onUntrustedAnswer)
  // and read at the post-unmount episode capture below: true once any answer rested on
  // untrusted-only sources → the stored episode is marked trusted:false (MemoryGraft).
  let sessionUntrusted = false;
  // `/new`: point the active-conversation pointer at a fresh (not-yet-persisted)
  // id — the OLD conversation stays in the store, listed by `muse chats` /
  // `/sessions`, instead of being cleared in place.
  const onReset = (): void => {
    // A new conversation starts fresh — don't carry a prior conversation's verdict
    // onto the new one (the capture summarises turns since the boundary).
    sessionUntrusted = false;
    void withBestEffort(startNewConversation(), undefined);
  };

  // `/sessions`: the numbered picker list, newest first.
  const listConversationsForRepl = async (): Promise<{ readonly activeId: string; readonly summaries: readonly ConversationSummary[] }> => {
    const [summaries, activeId] = await Promise.all([listConversations(), activeConversationId()]);
    return { activeId, summaries };
  };

  // `/resume <n|id-prefix>`: switch the active conversation, then reload the
  // model's context window from it (same seeding rule as boot).
  const resumeConversationByRef = async (ref: string): Promise<ResumeConversationResult> => {
    const resolution = await resumeConversation(ref);
    if (resolution.status === "not-found") {
      return { message: `No conversation found with id "${ref}". Run /sessions to see the list.`, ok: false };
    }
    if (resolution.status === "ambiguous") {
      const previews = resolution.candidates.map((c) => `${c.id} (${c.title})`).join(", ");
      return { message: `Ambiguous conversation id "${ref}" — matches ${resolution.candidates.length.toString()}: ${previews}`, ok: false };
    }
    const { messages: seedHistory } = await seedChatHistory();
    return { id: resolution.summary.id, ok: true, seedHistory, title: resolution.summary.title };
  };

  // Memory transparency/control surfaced inside the chat: /memory reads what
  // Muse knows, /remember teaches a fact, /forget drops one key. All re-read
  // from the store + refresh the persona holder so the change is reflected both
  // in /memory AND in the next turn's injected system prompt. Fail-soft.
  const memorySnapshot = async (): Promise<MemorySnapshot | undefined> => {
    if (!memoryStore) return undefined;
    try {
      const m = await memoryStore.findByUserId(userId);
      return m
        ? {
          facts: m.facts,
          preferences: m.preferences,
          recentTopics: m.recentTopics,
          ...(m.factHistory
            ? { factHistory: m.factHistory.map((e) => ({ key: e.key, previousValue: e.previousValue, replacedAt: e.replacedAt.toISOString() })) }
            : {})
        }
        : undefined;
    } catch {
      return undefined;
    }
  };
  const forgetMemory = async (key: string): Promise<boolean> => {
    if (!memoryStore?.forget) return false;
    try {
      const removed = await memoryStore.forget(userId, key);
      if (removed) {
        await refreshMemory();
        // Retraction marker (sibling of the CLI `memory forget`): the auto-extractor
        // must not silently resurface a fact the user forgot mid-chat (user > auto).
        try {
          await recordRetraction(new FileBeliefProvenanceStore(defaultBeliefProvenanceFile()), userId, normalizeMemoryKey(key));
        } catch { /* provenance is best-effort */ }
      }
      return removed;
    } catch {
      return false;
    }
  };
  const rememberFact = async (key: string, value: string): Promise<boolean> => {
    if (!memoryStore) return false;
    try {
      await memoryStore.upsertFact(userId, key, value);
      await refreshMemory();
      return true;
    } catch {
      return false;
    }
  };
  const setPreference = async (key: string, value: string): Promise<boolean> => {
    if (!memoryStore) return false;
    try {
      await memoryStore.upsertPreference(userId, key, value);
      await refreshMemory();
      return true;
    } catch {
      return false;
    }
  };
  const wipeMemory = async (): Promise<boolean> => {
    if (!memoryStore) return false;
    try {
      const dropped = await memoryStore.deleteByUserId(userId);
      await refreshMemory();
      return dropped;
    } catch {
      return false;
    }
  };
  const trustInfo = async (): Promise<{ trusted: readonly string[]; blocked: readonly string[] }> => {
    try {
      const t = await readTrust(userId);
      return { blocked: t.blockedTools, trusted: t.trustedTools };
    } catch {
      return { blocked: [], trusted: [] };
    }
  };

  // /recall — semantic search across the notes + episode indices. Reuses the
  // same pipeline as `muse recall`; fail-soft to a hint when Ollama is down or
  // no index has been built (the embed call throws / hits come back empty).
  const recallSearch = async (query: string): Promise<string> => {
    const q = query.trim();
    if (q.length === 0) return "What should I recall? — /recall <query>";
    const embedModel = process.env.MUSE_RECALL_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
    try {
      const warnings: string[] = [];
      const hits = await searchRecall({ query: q, source: "all", limit: 5, embedModel, env: process.env, onWarn: (m) => warnings.push(m.trim()) });
      const body = formatRecallHits(q, hits);
      return hits.length === 0 && warnings.length > 0 ? `${body}\n${warnings.join("\n")}` : body;
    } catch {
      return "Recall needs Ollama running + an index — try `muse notes reindex` / `muse episode reindex`.";
    }
  };

  // /reflect — cross-session synthesis: read this user's episodes and ask the
  // local model for ONE grounded observation (fenced against hallucination).
  // reflectInsight returns the RAW insight ("" when none); /reflect formats it
  // with a friendly empty-state, while the morning brief surfaces it ONLY when
  // non-empty (no "nothing stands out" nag at session open).
  const reflectInsight = async (): Promise<string> => {
    try {
      const all = await withBestEffort(readEpisodes(resolveEpisodesFile(process.env)), []);
      const mine = all.filter((episode) => episode.userId === userId);
      const reflectionProvider = provider as ReflectionProvider;
      return await synthesizeReflection({
        episodes: mine,
        model,
        provider: reflectionProvider,
        // Gate the live insight with the same RGV judge the offline dreaming path
        // uses — a confabulated cross-session observation is dropped, not spoken.
        reverify: buildModelGroundingReverify(reflectionProvider, model)
      });
    } catch {
      return "";
    }
  };
  const reflect = async (): Promise<string> => formatReflection(await reflectInsight());

  // /today — the morning briefing composed locally (tasks/events/weather/
  // headlines/reminders) so the small model never chains four tool calls.
  const todayBrief = (): Promise<string> =>
    withBestEffort(buildLocalTodayText(process.env, parseLookaheadHours(undefined)), "Couldn't compose today's briefing.");

  // /job — fire off a long-running task in a detached worker (same machinery
  // as `muse job run`) so the user keeps chatting; /jobs reads recent statuses.
  const startJob = (prompt: string): string => startBackgroundJob(prompt, {
    ...(options.userId ? { user: options.userId } : {}),
    ...(personaSlot ? { persona: personaSlot } : {})
  }).id;
  const jobsOverview = async (): Promise<readonly JobListItem[]> => {
    try {
      const summaries = await Promise.all(listRecentJobIds(8).map((id) => readJobSummary(id)));
      return summaries
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .map((s) => ({
          id: s.id,
          status: s.status,
          ...(s.prompt ? { prompt: s.prompt } : {}),
          ...(s.finalText ? { finalText: s.finalText } : {})
        }));
    } catch {
      return [];
    }
  };
  // Muse speaks up when a job started this session finishes. `chatStartedIso`
  // stops jobs that completed before launch from announcing on the first poll.
  const chatStartedIso = new Date().toISOString();
  const jobCompletions = async (): Promise<readonly ProactiveItem[]> => {
    const summaries = await Promise.all(listRecentJobIds(20).map((id) => readJobSummary(id)));
    return jobCompletionItems(
      summaries
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .map((s) => ({ id: s.id, status: s.status, finishedAt: s.finishedAt, prompt: s.prompt, finalText: s.finalText })),
      chatStartedIso
    );
  };

  // /orchestrate — a background sub-agent fan-out (direct-answer + risk-critic,
  // both on the SAME provider/model this chat already runs) that never blocks
  // the calling turn; the consolidated result surfaces through the SAME
  // proactive-item poll `/job` completions use, one entry per orchestration.
  const chatOrchestration = createChatOrchestration(provider, model);
  const startOrchestration = (prompt: string): { orchestrationId: string; subtaskCount: number } =>
    chatOrchestration.startOrchestration(prompt);
  const orchestrationCompletions = async (): Promise<readonly ProactiveItem[]> =>
    orchestrationCompletionsFrom(chatOrchestration.listRecords(), chatStartedIso);

  // Launch recap — "where we left off": the most recent episode summary plus
  // open-commitment counts. Only when resuming a continuous session; fail-soft
  // to no recap if any store is missing/unreadable.
  const oneLineRecap = continueHistory
    ? await withBestEffort((async (): Promise<string> => {
        const [episodes, tasks, followups] = await Promise.all([
          withBestEffort(readEpisodes(resolveEpisodesFile(process.env)), []),
          withBestEffort(readTasks(resolveTasksFile(process.env)), []),
          withBestEffort(readFollowups(resolveFollowupsFile(process.env)), [])
        ]);
        const latest = [...episodes].sort((a, b) => a.endedAt.localeCompare(b.endedAt)).at(-1);
        const openCommitments = detectUserCommitments(
          seedLines.filter((line) => line.role === "user").map((line) => line.content)
        ).length;
        return buildRecap({
          ...(latest ? { lastEpisode: latest.summary } : {}),
          pendingTasks: tasks.filter((t) => t.status === "open").length,
          pendingFollowups: followups.filter((f) => f.status === "scheduled").length,
          openCommitments
        });
      })(), "")
    : "";

  // The chat opens INSTANTLY — no auto-briefing at startup. Composing the morning
  // brief here forced a weather network fetch + two local-model reflection calls
  // on every first-open-of-the-day, so a bare `muse` took seconds to even appear.
  // The day view is surfaced ON DEMAND (`muse today` / the `/today` slash command),
  // and the opener stays a cheap local one-line recap.
  let recap = oneLineRecap;
  const recapRole: "system" | "command" = "system";

  // "You FEEL it next session" (B2): if Muse distilled anything UNATTENDED
  // while you were away (probation strategies), open with a one-line beat so
  // the growth is perceived — deterministic, fail-soft, silent when nothing.
  if (continueHistory) {
    const idleNotice = await withBestEffort(idleLearnedNoticeForUser(userId), undefined);
    if (idleNotice) {
      recap = recap ? `${idleNotice}\n${recap}` : idleNotice;
    }
  }

  // Skills: each is a `~/.muse/skills/<name>/SKILL.md` (claude-style). Their
  // instructions are injected into the system prompt so the local model can
  // follow the relevant one. Add a skill = drop a folder there.
  const skillsDir = process.env.MUSE_SKILLS_DIR?.trim() || join(homedir(), ".muse", "skills");
  const authoredSkillsDir =
    process.env.MUSE_AUTHORED_SKILLS_DIR?.trim() || join(homedir(), ".muse", "skills", "authored");
  const userSkills = await withBestEffort(loadSkillsFromDirectory(skillsDir, "user"), [] as readonly Skill[]);
  const authoredSkills = await withBestEffort(
    loadSkillsFromDirectory(authoredSkillsDir, "authored"),
    [] as readonly Skill[]
  );
  // User skills override authored on name collision (authored = lowest precedence, mirrors buildSkillRegistry)
  const skillMap = new Map<string, Skill>();
  for (const s of authoredSkills) skillMap.set(s.name, s);
  for (const s of userSkills) skillMap.set(s.name, s);
  const skills = [...skillMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const authoredStore = new AuthoredSkillStore({ dir: authoredSkillsDir });
  // RL over skills (from prior sessions): a skill corrected into the avoid
  // floor is dropped from this session's prompt entirely; a reinforced one
  // wins the limited body slots. Loaded once at start.
  const skillRewards = await withBestEffort(readSkillRewards(resolveSkillRewardsFile(process.env)), {});
  const skillsPromptFor = (prompt: string): string =>
    buildSkillsPrompt(
      skills,
      prompt,
      (skill) => {
        if (skill.sourceInfo.source === "authored") void authoredStore.recordUsage(skill.name);
      },
      (name) => isSkillAvoided(skillRewards[name]),
      (name) => skillRewards[name] ?? 0
    );
  const skillInfos = skills.map((s) => ({ description: s.description, name: s.name }));

  // Manually-defined agents (`~/.muse/agents/<name>/AGENT.md`). `/agent <name>`
  // switches the active one in chat; its body becomes the system prompt.
  const agents = await withBestEffort(loadAgents(resolveAgentsDir(process.env)), [] as readonly AgentDef[]);

  // Models the provider can serve (for the `/model` picker). Always include
  // the current one even if listing fails or omits it.
  const modelInfos = await withBestEffort(provider.listModels(), []);
  const models = [...new Set([model, ...modelInfos.map((m) => `${m.providerId}/${m.modelId}`)])];

  // Just the art + tagline — the model and status live in the bottom HUD.
  const banner = renderMuseBanner().replace(/^\n+|\n+$/gu, "");
  // Enable the kitty keyboard protocol so the terminal disambiguates
  // modified keys (Shift+Enter → a distinct event Ink reports as
  // key.shift+return). Without it, legacy terminals send Shift+Enter as a
  // bare CR, indistinguishable from Enter. Supporting terminals (Ghostty/
  // cmux, iTerm2, kitty, WezTerm) opt in; others ignore the sequence.
  const proactiveOn = Boolean(process.env.MUSE_PROACTIVE_PROVIDER?.trim() && process.env.MUSE_PROACTIVE_DESTINATION?.trim());
  // Local-only posture for the HUD — same canonical source `muse doctor`/`muse
  // status` use, so the three surfaces never disagree about cloud-egress.
  const localOnly = evaluateLocalOnlyPosture(process.env).enabled;

  // Speaks-first source: imminent reminders + follow-ups from the local
  // stores. (Messenger push already runs via the proactive daemon; this
  // surfaces the same items inside the live chat.)
  const remindersFile = resolveRemindersFile(process.env);
  const followupsFile = resolveFollowupsFile(process.env);
  const calendarFile = resolveLocalCalendarFile(process.env);
  const proactiveCheck = async (): Promise<readonly ProactiveItem[]> => {
    const now = new Date();
    const horizon = new Date(now.getTime() + PROACTIVE_LEAD_MS);
    const [reminders, followups, tasks, events] = await Promise.all([
      withBestEffort(readDueReminders(remindersFile, horizon), []),
      withBestEffort(readDueFollowups(followupsFile, horizon), []),
      withBestEffort(readTasks(resolveTasksFile(process.env)), []),
      withBestEffort(new LocalCalendarProvider({ file: calendarFile }).listEvents({ from: now, to: horizon }), [])
    ]);
    return [
      ...reminders.map((r) => ({ dueAt: r.dueAt, id: r.id, text: r.text })),
      ...followups.map((f) => ({ dueAt: f.scheduledFor, id: f.id, text: f.summary })),
      ...dueTaskItems(tasks, horizon.getTime()),
      ...calendarEventItems(
        events.map((e) => ({ id: e.id, startsAtIso: e.startsAt.toISOString(), title: e.title })),
        horizon.getTime()
      )
    ];
  };

  // Non-windowed proactive nudges surfaced IN-CHAT (P-N3): the same due
  // check-ins the daemon would push to the channel, plus fireable behaviour
  // patterns, so a user living in `muse` chat sees them too. Read-only — the
  // daemon owns delivery state, so a check-in it already fired (status flipped)
  // and a pattern within its fired-cooldown never re-surface here. Pattern
  // surfacing rides the existing opt-in (`MUSE_PROACTIVE_PATTERN_ENABLED`) so
  // the per-poll notes walk only runs for users who asked for patterns;
  // check-ins (a cheap one-file read) always surface. Best-effort.
  const checkinsStore = checkinsFile(process.env);
  const patternsInChat = parseBoolean(process.env.MUSE_PROACTIVE_PATTERN_ENABLED, false);
  const proactiveNudges = async (): Promise<readonly ProactiveItem[]> => {
    const now = Date.now();
    const checkins = await withBestEffort(readCheckins(checkinsStore), []);
    const items: ProactiveItem[] = [...checkinItems(checkins, now)];
    if (patternsInChat) {
      try {
        const signals = await aggregateActivitySignals({ now: () => now });
        const fired = await readPatternsFired(resolvePatternsFiredFile(process.env));
        const fireable = selectFireablePatterns(new Date(now), signals, fired);
        items.push(...patternSuggestionItems(fireable.map((m) => ({ id: m.id, suggestion: m.suggestion }))));
      } catch { /* fail-soft — a signal/IO glitch never breaks the chat poll */ }
    }
    return items;
  };

  // Multi-turn retrieval parity with `runLocalChat`: the Ink surface retrieved
  // on the RAW turn only — this was the one chat path that never resolved an
  // anaphoric follow-up into a self-contained query before grounding.
  const groundingForTurn = createContextualGroundingLookup({
    retrieve: retrieveChatGrounding,
    ...(provider && "generate" in provider
      ? {
          rewrite: async (history, prompt) => {
            const rewritten = await provider.generate({
              maxOutputTokens: 80,
              messages: [
                { content: QUERY_REWRITE_SYSTEM_PROMPT, role: "system" },
                { content: buildQueryRewritePrompt(history, prompt), role: "user" }
              ],
              model,
              responseFormat: QUERY_REWRITE_RESPONSE_FORMAT,
              temperature: 0
            });
            return parseQueryRewrite(rewritten.output ?? "", prompt);
          }
        }
      : {})
  });
  const instance = render(h(MuseChatApp, {
    agents,
    banner,
    history,
    model,
    models,
    onCommit,
    autoLearn,
    onReset,
    listConversations: listConversationsForRepl,
    resumeConversationByRef,
    onUntrustedAnswer: () => { sessionUntrusted = true; },
    personaPrompt,
    proactiveCheck,
    proactiveNudges,
    readFile,
    readImage,
    saveText,
    copyToClipboard,
    proactiveOn,
    localOnly,
    modelProviderId: process.env.MUSE_MODEL_PROVIDER_ID?.trim() || providerIdFromModel(model),
    modelBaseUrl: process.env.MUSE_MODEL_BASE_URL?.trim() || process.env.OLLAMA_BASE_URL?.trim() || undefined,
    cloudKeyPresent: hasCloudCredential(process.env),
    skills: skillInfos,
    skillsDir,
    skillsPromptFor,
    finalizeAnswer: async (args) => {
      const snap = await withBestEffort(memorySnapshot(), undefined);
      const judge = assembly.modelProvider && "generate" in assembly.modelProvider
        ? createQwenReverify(assembly.modelProvider, assembly.defaultModel ?? "default")
        : undefined;
      const finalized = await finalizeGatedChatAnswer({
        ...args,
        knownFactKeys: Object.keys(snap?.facts ?? {}),
        memories: Object.entries(snap?.facts ?? {}).map(([key, value]) => ({ key, value })),
        embed: defaultChatConflictEmbedder(),
        ...(judge ? { reverify: judge } : {})
      });
      // Trace parity with the single-turn path (cli.local): interactive Ink turns
      // previously wrote NO run-log trace, so a misgrounding in the MOST-USED
      // surface was invisible to error analysis (zero flywheel fuel from real
      // sessions).
      await recordChatTurnTrace({
        answer: finalized.forHistory,
        matches: args.matches,
        ...(assembly.defaultModel !== undefined ? { model: assembly.defaultModel } : {}),
        question: args.question,
        source: "cli.ink"
      });
      // Whetstone weakness-ledger parity with `runLocalChat`: the interactive Ink
      // surface (the MOST-USED chat path) previously never classified/persisted/
      // resolved a turn's failure signal or surfaced the repeat-weakness nudge.
      const nudge = await recordChatTurnWeakness({
        answer: finalized.forHistory,
        matches: args.matches,
        question: args.question,
        ...(args.toolsUsed ? { toolsUsed: args.toolsUsed } : {})
      });
      return nudge ? { ...finalized, display: `${finalized.display}${nudge}` } : finalized;
    },
    groundingFor: groundingForTurn,
    historyWindow: resolveChatHistoryWindow(process.env),
    contextWindow: buildContextWindowOptions(process.env),
    // `/compact <topic>` (a real, focused compaction) uses the SAME model
    // the chat already runs, via the CMP-2 aux summarizer — no separate
    // provider/key needed.
    contextSummarizer: createModelDroppedContextSummarizer(provider, model),
    stream,
    streamWithTools,
    cloudTurn,
    memorySnapshot,
    forgetMemory,
    rememberFact,
    setPreference,
    wipeMemory,
    trustInfo,
    ...(personaSlot ? { persona: personaSlot } : {}),
    recallSearch,
    reflect,
    todayBrief,
    startJob,
    jobsOverview,
    jobCompletions,
    startOrchestration,
    orchestrationCompletions,
    recap,
    recapRole,
    inputHistorySeed,
    onInput: (value: string) => { void appendInputHistory(value); },
    ...(personaEpisodes.length > 0 ? { episodeInfo: { count: personaEpisodes.length, ...(personaEpisodes[0]?.endedAt ? { lastAt: personaEpisodes[0].endedAt } : {}) } } : {}),
    ...(recurringThreads.length > 0 ? { recurringThreads } : {})
  }), {
    exitOnCtrlC: false,
    kittyKeyboard: { flags: ["disambiguateEscapeCodes"], mode: "enabled" }
  });
  await instance.waitUntilExit();

  // End-of-session opt-in distillation sequence (episode capture + idle-learning
  // / playbook / skill / check-in / preference distill steps). Each step is
  // opt-in + fail-soft so a flaky model never blocks exit.
  await runEndOfSessionPipeline({
    modelProvider: assembly.modelProvider,
    model,
    userId,
    sessionUntrusted
  });
  // Clean shutdown reached — clear the crash marker so the next boot doesn't
  // misreport this session as a crash.
  await withBestEffort(endSessionClean(sesMarker), undefined);
}

/**
 * Most-recent episodes for a user, newest-first + capped, shaped for the
 * persona block (so past sessions ride into the system prompt). Best-effort.
 */
async function loadPersonaEpisodes(
  userId: string
): Promise<readonly { readonly endedAt: string; readonly summary: string; readonly topics?: readonly string[] }[]> {
  const all = await readEpisodes(resolveEpisodesFile(process.env));
  const capRaw = Number(process.env.MUSE_EPISODIC_MEMORY_MAX_ENTRIES);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.trunc(capRaw) : 20;
  const mine = all.filter((entry) => entry.userId === userId);
  return selectPersonaEpisodes(mine, cap).map((entry) => ({
    endedAt: entry.endedAt,
    summary: entry.summary,
    ...(entry.topics && entry.topics.length > 0 ? { topics: entry.topics } : {})
  }));
}
