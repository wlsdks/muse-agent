/**
 * Context / system-prompt ASSEMBLY for `muse ask`, lifted out of the commands-ask
 * god-file (4th decomposition pass). Covers the withTools-only manual note-context
 * pipeline (dedup near-duplicate chunks, Lost-in-the-Middle reorder, stale demotion,
 * CRAG confidence framing, value-conflict detection), the personal-store / user-
 * memory (incl. cross-lingual rescue + provisional/contested/stale provenance marks)
 * / activity / playbook grounding blocks, and the shared banner + system-prompt +
 * citation-normalization builders BOTH `muse ask` paths consume.
 *
 * `muse ask --with-tools` builds its own context block + system prompt inline (it
 * feeds `assembly.agentRuntime.run`, not the seam's generate callback). The plain
 * chat-only path composes the SAME retrieval→dedup→reorder→demoteStale→context-
 * block→system-prompt work through `runGroundedRecall`'s seam (`streamGroundedRecall`)
 * so it stays byte-identical to the API/MCP callers of that pipeline instead of a
 * second hand-maintained copy — this module owns the withTools-only half plus every
 * grounding block/builder BOTH paths share.
 *
 * Pure assembly — no model call, no streaming. The caller still owns actually
 * generating the answer (agentRuntime.run / streamGroundedRecall) using the values
 * returned here: `systemPrompt`/`notesFraming`/`contextBlock` start at their withTools
 * (or empty) value and the caller's own branch may rebuild/reassign them; `scored` is
 * reassigned here by the dedup pass and must flow back to the caller, which reassigns
 * it again once its own branch's retrieval settles.
 */

import {
  classifyActionRequest,
  detectEvidenceContradictions,
  isInjectableStrategy,
  isMemoryInjection,
  lexicalTokens,
  normalizeContactCitations,
  normalizeFromPrefixedCitations,
  normalizeMemoryCitations,
  normalizeSlotCitations,
  renderPlaybookSection,
  reorderForLongContext,
  type ContradictionPair
} from "@muse/agent-core";
import type { enforceAnswerCitations } from "@muse/agent-core";
import {
  contestedFactKeys,
  defaultBeliefProvenanceFile,
  deriveFactProvenance,
  FileBeliefProvenanceStore,
  normalizeMemoryKey,
  provisionalFactKeys,
  staleFactKeys
} from "@muse/memory";
import type { UserMemory } from "@muse/memory";
import type { MuseRuntimeAssembly } from "@muse/autoconfigure";
import { acquireOllamaLease, resolveOllamaLeaseFile } from "@muse/stores";
import {
  allUserMemoryFacts,
  buildMemoryContextBlock,
  buildNoteContextBlock,
  dedupNearDuplicateChunks,
  demoteStale,
  groundedSourceSummary,
  notesGroundingFraming,
  relativizeNoteSource,
  renderMemoryFact,
  selectMemoryFacts,
  selectPlaybookSection,
  selectProbationSuggestion,
  stripGroundingFences,
  topAppliedStrategy,
  type ScoredChunk
} from "@muse/recall";
import type { createStageTimer } from "@muse/recall";
import type { SessionFeedReflectionGrounding } from "./ask-session-grounding.js";
import { createRunId } from "@muse/shared";

import { cosine } from "./commands-notes-rag.js";
import { embed } from "./embed.js";
import { rankPlaybookEntriesByRelevance } from "./playbook-embed-rank.js";
import { rescueMemoryCrossLingual } from "./ask-cross-lingual.js";
import { buildActivityGrounding } from "./ask-activity-grounding.js";
import { buildPersonalStoreGrounding } from "./ask-personal-store-grounding.js";
import { buildAskSystemPrompt } from "./ask-system-prompt.js";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";
import type { AskOptions } from "./ask-command-options.js";
import type { AskStreamResult, DecompositionTrustSignals } from "./ask-result-output.js";
import type { ProgramIO } from "./program.js";

export interface AskContextAssemblyInput {
  readonly query: string;
  readonly embedModel: string;
  readonly notesDir: string;
  readonly options: AskOptions;
  readonly io: ProgramIO;
  readonly assembly: MuseRuntimeAssembly;
  readonly userKey: string;
  readonly userMemory: UserMemory | undefined;
  readonly personaPrompt: string | undefined;
  readonly personaTemplatePreamble: string;
  readonly untrustedNoteSources: ReadonlySet<string>;
  readonly scored: ScoredChunk[];
  readonly preGapScored: readonly ScoredChunk[];
  readonly notesUnavailable: boolean;
  readonly episodeHits: SessionFeedReflectionGrounding["episodeHits"];
  readonly episodeBlock: string;
  readonly feedHeadlines: SessionFeedReflectionGrounding["feedHeadlines"];
  readonly feedBlock: string;
  readonly browsingHits: SessionFeedReflectionGrounding["browsingHits"];
  readonly browsingBlock: string;
  readonly reflectionLines: SessionFeedReflectionGrounding["reflectionLines"];
  readonly reflectionBlock: string;
  readonly askStages: ReturnType<typeof createStageTimer>;
}

export async function assembleAskContext(input: AskContextAssemblyInput) {
  const {
    query, embedModel, notesDir, options, io, assembly, userKey, userMemory, personaPrompt,
    personaTemplatePreamble, untrustedNoteSources, preGapScored, notesUnavailable,
    episodeHits, episodeBlock, feedHeadlines, feedBlock, browsingHits, browsingBlock,
    reflectionLines, reflectionBlock, askStages
  } = input;
  let scored = input.scored;

  // Never reassigned within this function — the caller's own branch
  // (--with-tools inline, or the chat-only seam's composeSystemPrompt
  // callback) rebuilds it from the returned `buildFullSystemPrompt`.
  const systemPrompt = "";
  let notesFraming: { readonly verdict: "confident" | "ambiguous" | "none"; readonly header: string; readonly guidance?: string } = { header: "", verdict: "none" };
  let contextBlock = "";
  if (options.withTools) {
    // Compose RAG context block. Edge-place the chunks (most relevant at
    // the start + end, least in the middle) per "Lost in the Middle" so the
    // small local model actually attends to the strongest grounding.
    // Graph-link + second-hop AUGMENT chunks are appended after MMR and
    // bypass it, so a near-identical chunk (same fact across two notes, or a
    // bridge near a seed) can pad the small model's context. Drop provable
    // near-duplicates first-wins (highest-ranked survives); fail-open on any
    // chunk without a comparable embedding (e.g. --file ad-hoc passages).
    scored = dedupNearDuplicateChunks(scored, cosine);
    // reorderForLongContext re-sorts by raw cosine score, which would put a
    // higher-scoring but explicitly-superseded chunk back ahead of its current
    // counterpart — so the stale demotion (already applied once inside
    // retrieveAndRankNotes) must run again on its output, not before it.
    const contextChunks = demoteStale(reorderForLongContext(scored), (c) => c.chunk.text);
    // CRAG: grade the notes' retrieval confidence so a weak near-miss isn't
    // presented to the small model as something to cite as fact.
    notesFraming = notesGroundingFraming(scored, query, preGapScored.length > 0 ? preGapScored : undefined, embedModel);
    // Detect value-conflicts between retrieved notes (arXiv:2504.19413) so
    // reconciliation arrives as DATA, not a fragile prompt instruction.
    // Fail-open: any embed error → no annotations → today's behaviour.
    const noteContradictions: readonly ContradictionPair[] = notesUnavailable || contextChunks.length < 2
      ? []
      : await detectEvidenceContradictions(
          contextChunks.map((r) => ({ score: r.score, source: relativizeNoteSource(r.file, notesDir), text: r.chunk.text })),
          (t) => embed(t, embedModel)
        ).catch(() => []);
    contextBlock = notesUnavailable
      ? "(notes search unavailable this turn — answer from the other grounding sources)"
      : contextChunks.length === 0
        ? "(no relevant notes found)"
        // The trailing `[from FILE]` is a COPY-READY token: a small local
        // model (qwen3:8b) parrots placeholders ("FILENAME") and even fake
        // example paths verbatim, so don't ask it to substitute — hand it the
        // exact real bracket to copy. NO "cite as:" label before it: qwen
        // copies the whole line, leaking the label into the answer ("…1380.
        // cite as: [from vpn.md]") — visible on the demo. The source is shown
        // relative to the notes dir (clean + locatable), not the absolute path.
        : buildNoteContextBlock(contextChunks, noteContradictions, notesDir, untrustedNoteSources);
  }

  // Personal-store grounding — open tasks / upcoming calendar / pending
  // reminders / matching contacts. Each gated by its flag (default-on),
  // fail-soft. See ask-personal-store-grounding.ts.
  const { calendarBlock, contactBlock, matchedContacts, openTasks, pendingReminders, reminderBlock, taskBlock, upcomingEvents } =
    await buildPersonalStoreGrounding({
      calendar: options.calendar !== false,
      calendarDays: options.calendarDays,
      contacts: options.contacts !== false,
      query,
      reminders: options.reminders !== false,
      tasks: options.tasks !== false
    });

  // User-memory grounding (B3): facts the user told Muse to remember
  // ("I'm allergic to penicillin") are injected into the PERSONA so the model
  // knows them — but without a citable source it misattributes the fact to a
  // random note (`[from n.md]`) and the verdict false-flags a TRUE answer.
  // Surface the query-relevant remembered facts as a first-class cited source
  // with the `[memory: <topic>]` hint, so a fact the user explicitly told Muse
  // is cited to MUSE'S MEMORY, not a note that never mentioned it.
  const allMemoryFacts = userMemory ? allUserMemoryFacts(userMemory) : [];
  let matchedMemories = userMemory ? selectMemoryFacts(userMemory, lexicalTokens(query)) : [];
  // Cross-lingual rescue: a KO query against EN facts (or vice-versa) scores
  // lexical-0, so the true fact never grounds → a false "I'm not sure". When
  // lexical found nothing, fall back to semantic cosine (fail-soft: an embed
  // failure leaves the lexical-empty result untouched).
  if (matchedMemories.length === 0 && userMemory && allMemoryFacts.length > 0) {
    try {
      matchedMemories = await rescueMemoryCrossLingual(userMemory, query, lexicalTokens(query), (t) => embed(t, embedModel));
    } catch { /* embed unavailable — keep lexical-empty result */ }
  }
  // G4-followup: mark a matched fact PROVISIONAL when it failed the durable-
  // promotion gate (a once-seen auto-extract, possibly a mis-extraction) so it's
  // grounded cautiously, not asserted as confirmed truth. Fail-soft — no
  // provenance log ⇒ no annotation.
  let provisionalMemoryKeys: ReadonlySet<string> = new Set();
  let contestedMemoryKeys: ReadonlySet<string> = new Set();
  let staleMemoryKeys: ReadonlySet<string> = new Set();
  if (matchedMemories.length > 0) {
    try {
      const provEntries = await new FileBeliefProvenanceStore(defaultBeliefProvenanceFile()).query(userKey);
      const provenance = deriveFactProvenance(provEntries);
      const nowMs = Date.now();
      provisionalMemoryKeys = provisionalFactKeys(
        matchedMemories.map((m) => m.key),
        provenance,
        { isInjection: isMemoryInjection, normalizeKey: normalizeMemoryKey, now: nowMs }
      );
      // CONTESTED: a matched fact whose value FLIPPED across confirmations — surface
      // the volatile-belief signal (today only the daily recap sees it) at point-of-
      // use, so a grounded answer says "confirm it's current" instead of a factually
      // wrong "learned once". Takes precedence over the provisional mark in render.
      contestedMemoryKeys = contestedFactKeys(
        matchedMemories.map((m) => m.key),
        provenance,
        { normalizeKey: normalizeMemoryKey, now: nowMs }
      );
      // STALE: a matched fact last confirmed long ago — point-of-use caution that it
      // may be out of date (the mildest mark; render never double-marks a contested/
      // provisional key). Same provenance, same fail-soft scope.
      staleMemoryKeys = staleFactKeys(
        matchedMemories.map((m) => m.key),
        provenance,
        { normalizeKey: normalizeMemoryKey, now: nowMs }
      );
    } catch { /* provenance unavailable — ground without the marks */ }
  }
  const memoryBlock = buildMemoryContextBlock(matchedMemories, { contestedKeys: contestedMemoryKeys, provisionalKeys: provisionalMemoryKeys, staleKeys: staleMemoryKeys });

  // Activity grounding — shell history / git reflog / action log. Each reads a
  // FILE (no spawn), gated by its flag, fail-soft. See ask-activity-grounding.ts.
  const { actionBlock, gitBlock, matchedActions, matchedCommands, matchedCommits, shellBlock } =
    await buildActivityGrounding({
      actions: options.actions !== false,
      embedModel,
      git: options.git === true,
      query,
      shell: options.shell === true
    });

  // Phase 2 (runtime self-tuning): the ACE playbook's [Learned
  // Strategies] reach the agent-runtime (--with-tools) path via the
  // runtime's playbookProvider, but NOT this chat-only fast path. Pull
  // them in for the chat-only stream below so past feedback shapes the
  // default `muse ask` answer too. Fail-soft; zero strategies ⇒ no block.
  let playbookSection: string | undefined;
  let appliedStrategy: string | undefined;
  // The id of the strategy actually injected (top-ranked) — so a verified-grounded
  // answer can implicitly REINFORCE it below (the positive half of the loop).
  let appliedStrategyId: string | undefined;
  // A relevant PROBATION strategy (one the daemon distilled UNATTENDED from a
  // past correction — recorded but NEVER injected) to SURFACE as a suggestion
  // at recall time, so a correction the user made resurfaces the moment its
  // topic recurs and they can choose to apply it. Surface-only — never injected
  // into the model's reasoning (the held graduation stays user-gated).
  let probationSuggestion: { readonly text: string; readonly id: string } | undefined;
  try {
    const { queryPlaybook } = await import("@muse/stores");
    const { resolvePlaybookFile } = await import("@muse/autoconfigure");
    const envTopK = Number(process.env.MUSE_PLAYBOOK_INJECT_TOPK);
    const topK = Number.isFinite(envTopK) && envTopK >= 1 ? envTopK : undefined;
    const entries = await queryPlaybook(resolvePlaybookFile(process.env as Record<string, string | undefined>), userKey);
    probationSuggestion = selectProbationSuggestion(entries, query);
    // Embedding-ranked strategy retrieval (opt-in): rank by semantic
    // similarity so a strategy phrased differently from the query still
    // surfaces, instead of pure lexical token-overlap. Off by default (it
    // adds a local nomic pass per strategy); fail-soft back to lexical.
    if (process.env.MUSE_PLAYBOOK_EMBED_RANK === "true") {
      const embedModel = process.env.MUSE_PLAYBOOK_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
      const ranked = await rankPlaybookEntriesByRelevance(
        entries, query, (text) => embed(text, embedModel), topK, Date.now()
      );
      playbookSection = renderPlaybookSection(ranked);
      appliedStrategy = playbookSection ? ranked[0]?.text : undefined;
    } else {
      playbookSection = selectPlaybookSection(entries, query, topK);
      appliedStrategy = playbookSection ? topAppliedStrategy(entries, query, topK) : undefined;
    }
    // The applied strategy's id (for implicit reinforcement below) — matched in
    // the store entries (which carry the id) by the injected text. MUST also be
    // INJECTABLE: a probation/avoided entry with byte-identical text must never be
    // the match, else a +0.1 reward would auto-graduate a probation strategy and
    // break the user-gated self-confirmation guard.
    appliedStrategyId = appliedStrategy ? entries.find((e) => e.text === appliedStrategy && isInjectableStrategy(e))?.id : undefined;
  } catch {
    playbookSection = undefined;
    appliedStrategy = undefined;
    appliedStrategyId = undefined;
    probationSuggestion = undefined;
  }

  // Show citation header before streaming the answer so the user
  // sees what's being grounded against, then the model output. Shared by
  // both paths — the plain path calls it from the seam's pre-generation
  // `retrieval` event so the ordering (banner → "generating…" → tokens)
  // matches the --with-tools path exactly.
  const printGroundedBanner = (scoredForBanner: readonly ScoredChunk[], verdictForBanner: "confident" | "ambiguous" | "none"): void => {
    const notesConf = verdictForBanner === "ambiguous" ? " ⚠ LOW confidence — verify, may not be in your notes" : "";
    const groundedParts = groundedSourceSummary({
      notesPart: scoredForBanner.length > 0 ? `${scoredForBanner.length.toString()} note chunk(s) — ${scoredForBanner.map((r) => r.file.split("/").pop()).join(", ")}${notesConf}` : null,
      openTasks: openTasks.length,
      upcomingEvents: upcomingEvents.length,
      pendingReminders: pendingReminders.length,
      contacts: matchedContacts.length,
      memories: matchedMemories.length,
      shellCommands: matchedCommands.length,
      gitCommits: matchedCommits.length,
      loggedActions: matchedActions.length,
      pastSessions: episodeHits.length,
      feedHeadlines: feedHeadlines.length,
      browsingVisits: browsingHits.length
    });
    // Grounding diagnostic goes to stderr so `muse ask "?" > answer.txt`
    // and `| jq` style pipelines get a clean stdout. Same convention
    // as the auto-reindex banner above. The blank line separating
    // header from answer body stays out of stdout entirely.
    // Suppressed for an ACTION request (`--with-tools "set a reminder…"`): the
    // user wants Muse to DO something, so a "grounded on lease.md ⚠ LOW
    // confidence" recall banner on the action confirmation is just noise.
    if (!classifyActionRequest(query)) {
      if (groundedParts.length > 0) {
        io.stderr(`(grounded on ${groundedParts.join("; ")})\n`);
      } else {
        io.stderr("(no matching notes, tasks, events, or reminders — answering from persona + general knowledge)\n");
      }
    }
  };
  // Same ordering rationale as the banner: shared so a caller can announce
  // right when ITS retrieval/prep phase actually finished.
  const announceGenerating = (): void => {
    if (options.json) return;
    // Name the ACTUAL backend — a privacy-first user must never read "local
    // model" while the answer is being generated on a cloud provider.
    const providerId = assembly.modelProvider?.id;
    const where = providerId === "codex"
      ? "via Codex (your ChatGPT subscription)"
      : providerId === "ollama" || providerId === "lmstudio" || providerId === "diagnostic"
        ? "on the local model"
        : "on the cloud model";
    io.stderr(`💭 generating your answer ${where}…\n`);
  };

  // --notes-only hard-disables native web_search (the adapters
  // honour enabled:false and skip the upstream tool request)
  // and clamps the tool registry (allowedToolNames below).
  const webSearchPolicy = options.notesOnly
    ? { enabled: false, maxUses: 0 }
    : undefined;

  // The 8 fields below are placeholders the CALLER fills in once its own
  // branch (--with-tools inline, decomposition, or the chat-only seam)
  // actually generates an answer — never reassigned within this function.
  const collectedAnswer = "";
  const answerLogprobs: AskStreamResult["logprobs"] = undefined;
  const toolsUsed: readonly string[] = [];
  // Populated at the end of EITHER branch below — the notes citation
  // allowlist, the full (notes + every other source) citation allowlist,
  // and the FIRST-pass-only stripped-citation list (pre-refusal-strip;
  // what the --json `strippedCitations` field and the stderr warning use).
  const allowedNotes: readonly string[] = [];
  const citationAllowed: Parameters<typeof enforceAnswerCitations>[1] = {};
  const preRefusalStrippedCitations: readonly string[] = [];
  // One run id shared across the runtime input, token-usage attribution, the
  // checkpoints, AND the run-log filename — so per-run cost works and `muse
  // trace <id>` links a run to its steps (they were unrelated ids).
  const askRunId = createRunId();
  // The agent's read-tool outputs (web fetches, knowledge_search, …) — the
  // evidence the --with-tools answer was grounded in. Fed into the output
  // grounding verdict below so a web-grounded answer isn't false-flagged
  // against the notes-only evidence set.
  const agentGroundingSources: readonly { readonly source: string; readonly text: string }[] = [];
  const decompositionSignals: DecompositionTrustSignals | undefined = undefined;
  // S3 narrate-the-wait (B2): the real generation stage — the silent gap
  // before the first token on a 10–40s local model. A static, honest
  // line so the wait reads as working, not frozen (latency-honest: it
  // names the actual local-model step, invents nothing).
  askStages.mark("retrievalMs");
  // Hold the Ollama lease while we use the local model so the background
  // self-learning daemon defers instead of contending for it. Best-effort
  // (fail-soft): if the lease write fails we still answer, and process
  // exit frees it (the daemon ignores a dead-pid lease).
  const leaseFile = resolveOllamaLeaseFile(process.env as Record<string, string | undefined>);
  const acquireLease = async (): Promise<void> => {
    try {
      await acquireOllamaLease(leaseFile, process.pid, Date.now());
    } catch { /* best-effort */ }
  };
  // Shared by both branches below: the non-notes half of the citation
  // allowlist (the notes half depends on each branch's own retrieval —
  // withTools's live corpus scan vs. the seam's `scored`), and the
  // full-prompt builder (each branch supplies its own contextBlock +
  // notesFraming — withTools's own manual pipeline above, or the seam's).
  const nonNoteCitations = {
    actions: matchedActions.map((a) => a.what),
    browsing: browsingHits.map((h) => h.host),
    commands: matchedCommands,
    commits: matchedCommits.map((c) => c.subject),
    contacts: matchedContacts.map((c) => c.name),
    events: upcomingEvents.map((e) => e.title),
    feeds: feedHeadlines.map((h) => h.feedName),
    memories: allMemoryFacts.map(renderMemoryFact),
    reminders: pendingReminders.map((r) => r.text),
    sessions: episodeHits.map((e) => e.summary),
    tasks: openTasks.map((t) => t.title)
  };
  const buildFullSystemPrompt = (args: { readonly contextBlock: string; readonly notesFraming: { readonly guidance?: string; readonly header: string } }): string =>
    buildAskSystemPrompt({
      actionBlock,
      calendarBlock,
      contactBlock,
      contextBlock: args.contextBlock,
      browsingBlock,
      browsingHits,
      episodeBlock,
      episodeHits,
      feedBlock,
      feedHeadlines,
      gitBlock,
      matchedActions,
      matchedCommands,
      matchedCommits,
      matchedContacts,
      matchedMemories,
      memoryBlock,
      notesFraming: args.notesFraming,
      openTasks,
      pendingReminders,
      personaPrompt,
      personaTemplatePreamble,
      reflectionBlock,
      reflectionLines,
      reminderBlock,
      shellBlock,
      taskBlock,
      upcomingEvents,
      withTools: options.withTools === true
    });
  // Same 4-pass citation-normalization sequence BOTH branches need: the
  // model's raw structured-slot/contact/memory citation forms rewritten
  // into the canonical bracket the gate validates, then the grounding
  // scaffolding's fence markers scrubbed. Shared so it's written once.
  const normalizeAskCitations = (text: string): string => {
    let out = normalizeFromPrefixedCitations(text);
    out = normalizeSlotCitations(out, {
      action: matchedActions.map((a) => a.what),
      browsing: browsingHits.map((h) => h.host),
      command: matchedCommands,
      commit: matchedCommits.map((c) => c.subject),
      contact: matchedContacts.map((c) => c.name),
      event: upcomingEvents.map((e) => e.title),
      feed: feedHeadlines.map((h) => h.feedName),
      reminder: pendingReminders.map((r) => r.text),
      session: episodeHits.map((e) => e.summary),
      task: openTasks.map((t) => t.title)
    });
    out = normalizeContactCitations(out, matchedContacts.map((c) => ({ id: c.id, name: c.name })));
    out = normalizeMemoryCitations(out, allMemoryFacts.map((f) => f.key));
    return stripGroundingFences(out);
  };

  return {
    systemPrompt,
    notesFraming,
    contextBlock,
    scored,
    calendarBlock,
    contactBlock,
    matchedContacts,
    openTasks,
    pendingReminders,
    reminderBlock,
    taskBlock,
    upcomingEvents,
    allMemoryFacts,
    matchedMemories,
    memoryBlock,
    actionBlock,
    gitBlock,
    matchedActions,
    matchedCommands,
    matchedCommits,
    shellBlock,
    playbookSection,
    appliedStrategy,
    appliedStrategyId,
    probationSuggestion,
    printGroundedBanner,
    announceGenerating,
    webSearchPolicy,
    collectedAnswer,
    // The two casts below widen back past TS's control-flow narrowing: a
    // `const` initialized to exactly `undefined` narrows to the literal
    // `undefined` type at this return site, which would stop the caller from
    // later assigning a real value to its own (reassignable) copy.
    answerLogprobs: answerLogprobs as AskStreamResult["logprobs"],
    toolsUsed,
    allowedNotes,
    citationAllowed,
    preRefusalStrippedCitations,
    askRunId,
    agentGroundingSources,
    decompositionSignals: decompositionSignals as DecompositionTrustSignals | undefined,
    leaseFile,
    acquireLease,
    nonNoteCitations,
    buildFullSystemPrompt,
    normalizeAskCitations
  };
}
