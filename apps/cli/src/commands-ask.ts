/**
 * `muse ask <query>` — RAG-grounded one-shot question.
 *
 * The natural JARVIS surface: "what did I say about Q3 last week?"
 * Combines three layers Muse already owns:
 *   1. Persona snapshot from `~/.muse/user-memory.json`
 *      (so the reply is in the user's preferred language + style)
 *   2. Semantic search over `~/.muse/notes-index.json`
 *      (top-K chunks with cosine similarity, embedded with
 *      nomic-embed-text)
 *   3. Local Qwen via `OllamaProvider` (think:false fast path)
 *
 * Streams the answer to stdout. Returns 1 when no index exists
 * (caller is told to run `muse notes reindex` first).
 *
 * Differs from `muse chat <prompt>` by:
 *   - Always runs RAG retrieval first
 *   - Includes hit citations in the system prompt
 *   - Prompts the model to answer FROM the notes (with a "I don't
 *     see anything about that in your notes" fallback)
 *
 * Zero recurring cost — all local.
 */

import { existsSync } from "node:fs";

import { enforceAnswerCitations, withUngroundableFallback } from "@muse/agent-core";
import { describeImage } from "@muse/agent-core";
import { classifyActionRequest } from "@muse/agent-core";
import { createMuseRuntimeAssembly, resolveAnswerTemperature, resolveNoteProvenanceFile, type MuseEnvironment } from "@muse/autoconfigure";
import { readNoteProvenance, untrustedNotePaths } from "./note-provenance.js";
import { releaseOllamaLease } from "@muse/stores";

import { allUserMemoryFacts, collectCitedNoteAges, contactGroundingEvidence, contactMatchScore, filterNotesByScope, formatCoarseAge, formatContactBirthday, formatNonNoteReceipts, formatSourceReceipts, formatSourcesFooter, formatStalenessWarning, groundingSectionLines, provenanceDate, provenanceSnippet, relativizeNoteSource, relevantSnippet, renderMemoryFact, selectMemoryFacts } from "@muse/recall";
export { allUserMemoryFacts, collectCitedNoteAges, contactGroundingEvidence, contactMatchScore, filterNotesByScope, formatCoarseAge, formatContactBirthday, formatNonNoteReceipts, formatSourceReceipts, formatSourcesFooter, formatStalenessWarning, groundingSectionLines, provenanceDate, provenanceSnippet, relativizeNoteSource, relevantSnippet, renderMemoryFact, selectMemoryFacts };
import { answerIsRefusal, composeChatSystemContent, corpusOnboardingHint, formatCorpusOverview, formatGraphLinksSection, looksLikeBinaryContent, queryHasAdHocGrounding, shouldWarmClose, stripEchoedCiteAs, sufficiencyAdvisory, urlGroundingSource } from "@muse/recall";
export { answerIsRefusal, composeChatSystemContent, corpusOnboardingHint, formatCorpusOverview, formatGraphLinksSection, looksLikeBinaryContent, queryHasAdHocGrounding, shouldWarmClose, stripEchoedCiteAs, sufficiencyAdvisory, urlGroundingSource };
import { shouldSuggestRepair, shouldWarnStrippedCitations, suggestOptInSource } from "@muse/recall";
export { shouldSuggestRepair, shouldWarnStrippedCitations, suggestOptInSource };
import { augmentNoteEvidenceWithCited, selectFilePassages, selectGroundingActions, selectPlaybookSection, selectProbationSuggestion, topAppliedStrategy } from "@muse/recall";
export { augmentNoteEvidenceWithCited, selectFilePassages, selectGroundingActions, selectPlaybookSection, selectProbationSuggestion, topAppliedStrategy };
import { diversifyAskChunks, notesGroundingFraming } from "@muse/recall";
import { prepareGroundedRecall, streamGroundedRecall, type GroundedRecallExtras, type ScoredChunk } from "@muse/recall";

export { citationPrecisionNotice, citationRecallNotice, untrustedOnlyGroundingNotice } from "@muse/recall";
export { diversifyAskChunks, notesGroundingFraming };
export { listNoteFiles, notesCorpusFileCount, resolveAskMaxTools, selectGraphConnections };
export { collectAutoImageAttachments, loadImageAttachment };
export { CITATION_INSTRUCTION_LINES };
import { askOutcomeLabel, askWeaknessAxis, createStageTimer, recordAskWeakness, recordAskWeaknessResolved } from "@muse/recall";
export { askOutcomeLabel, askWeaknessAxis, createStageTimer, recordAskWeakness, recordAskWeaknessResolved };
import { drawBestGroundedRedraft, groundingVerdictNotice } from "@muse/recall";
export { drawBestGroundedRedraft, groundingVerdictNotice };
import { buildAskConnections } from "@muse/recall";
export { buildAskConnections };


import { CODEX_PROVIDER_ID, parseModelName } from "@muse/model";
import { applyCodexModelToEnv, resolveCodexActivation } from "./codex-cli.js";
import { routeAskTierModel } from "./ask-tier-models.js";
import { shouldDecompose } from "@muse/multi-agent";
import { decomposedAnswerOrRefusal, runDecomposedAgentAsk } from "./ask-decompose.js";
import { tryDeterministicAnswer } from "./ask-fast-paths.js";
export { CASUAL_RESPONSES, META_RESPONSE, ACTION_GUIDE } from "./ask-fast-paths.js";
import { decompositionJsonFields, decompositionStderrNotes, renderAskStreamError, type AskStreamEvent, type AskStreamResult } from "./ask-result-output.js";
export { decompositionJsonFields, decompositionStderrNotes, renderAskStreamError, type AskStreamEvent, type AskStreamResult } from "./ask-result-output.js";

export { resolveAskTierModels, routeAskTierModel } from "./ask-tier-models.js";
import type { Command } from "commander";

import { filterLiveNoteIndexFiles } from "./commands-recall.js";
import { embed } from "./embed.js";
import { buildAskRunLog, writeRunLog } from "./program-helpers.js";
import { buildMusePersona } from "./muse-persona.js";
import type { ProgramIO } from "./program.js";
import { withSigintAbort } from "./sigint-abort.js";
import { listNoteFiles, notesCorpusFileCount, resolveAskMaxTools, selectGraphConnections } from "./ask-corpus-helpers.js";
import { collectAutoImageAttachments, loadImageAttachment } from "./ask-image-attachments.js";
import { CITATION_INSTRUCTION_LINES } from "./ask-prompt-constants.js";
import { buildSessionFeedReflectionGrounding } from "./ask-session-grounding.js";
import { retrieveAndRankNotes } from "./ask-note-retrieval.js";
import { applyAdHocGrounding } from "./ask-adhoc-grounding.js";
import { buildAskToolWiring } from "./ask-tool-wiring.js";
import { resolveSessionVisionModel, runVisionCommandAction } from "./ask-vision-command.js";
import { runGroundingVerdict } from "./ask-grounding-verdict.js";
import { finalizeAndRenderAsk } from "./ask-finalize.js";
import { assembleAskContext } from "./ask-context-assembly.js";
import { applyAskOptions, type AskOptions } from "./ask-command-options.js";
export type { AskOptions };
import { composeAskInput } from "./ask-input.js";
import { notesIndexPath, prepareAskContext } from "./ask-context-setup.js";

/**
 * The allowlist consumed via `metadata.allowedToolNames` when
 * `muse ask --notes-only` runs in `--with-tools` mode. Notes +
 * notes-multi cover both inline and registry-aware paths; context
 * is the persona / memory accessor so the model can still reach
 * for "what did the user tell me about X". Web/fetch tools and
 * everything else stay off.
 */
export const NOTES_ONLY_TOOL_ALLOWLIST = ["muse.notes", "muse.notes-multi", "muse.context"] as const;

/**
 * Memory-WRITE tools the recall agent (`muse ask --with-tools`) must never
 * reach, passed via `metadata.forbiddenToolNames`. `muse ask` is a READ/recall
 * surface; authoring durable user-memory is the job of the explicit `muse
 * remember` command (user-directed) and chat auto-extraction (which gates on
 * what the USER actually stated). Left exposed, the local model autonomously
 * saved its OWN general-knowledge assertions (e.g. "WireGuard default MTU is
 * 1420") as facts ABOUT the user — which the next recall then cited as "🧠 from
 * what you told me", a provenance fabrication the user never made. Forbidding it
 * deterministically keeps recall read-only for memory.
 */
const RECALL_FORBIDDEN_TOOL_NAMES = ["remember_fact"] as const;

/**
 * Drain the chat-only fast-path model stream. A provider `error`
 * event (Ollama not running, model not pulled with an actionable
 * hint, a 5xx) must surface, not be silently dropped while the
 * command prints a blank answer and exits 0.
 */
export async function consumeAskStream(
  events: AsyncIterable<AskStreamEvent>,
  onDelta: (text: string) => void,
  isAborted: () => boolean
): Promise<AskStreamResult> {
  let answer = "";
  let logprobs: AskStreamResult["logprobs"];
  for await (const event of events) {
    if (isAborted()) break;
    if (event.type === "error") {
      return { answer, error: event.error?.message ?? "model request failed" };
    }
    if (event.type === "text-delta" && typeof event.text === "string") {
      answer += event.text;
      onDelta(event.text);
    }
    if (event.type === "done" && event.response?.logprobs && event.response.logprobs.length > 0) {
      logprobs = event.response.logprobs;
    }
  }
  return { answer, ...(logprobs ? { logprobs } : {}) };
}

export function registerAskCommand(program: Command, io: ProgramIO): void {
  applyAskOptions(program.command("ask"))
    .action(async (queryParts: readonly string[], options: AskOptions) => {
      const composedInput = await composeAskInput(queryParts, options, io);
      if (!composedInput.ok) {
        process.exitCode = 1;
        return;
      }
      const { query, imageAttachments } = composedInput;

      // Deterministic non-RAG short-circuits (social / arithmetic / date /
      // countdown / date-diff / unit / percentage / timezone / meta / action):
      // each is precision-first and skips retrieval, the empty-corpus on-ramp,
      // the citation gate, and the grounding-verdict warning. The local 8B is
      // confidently wrong on the numeric/date ones, so Muse computes them exactly
      // here — no model call, no embedding. A miss falls through to normal recall.
      const deterministic = tryDeterministicAnswer(query, options);
      if (deterministic) {
        if (options.json) {
          io.stdout(`${JSON.stringify(deterministic.jsonPayload)}\n`);
        } else {
          io.stdout(`${deterministic.answer}\n`);
        }
        return;
      }

      // Option resolution, auto-stale reindex, notes-index load/migration, and
      // the first-run onboarding hint — see ask-context-setup.ts.
      const context = await prepareAskContext(query, options, io);
      if (context.kind === "error") {
        process.exitCode = 1;
        return;
      }
      if (context.kind === "handled") {
        return;
      }
      const { userKey, topK, embedModel, notesDir, index, noteFileCount } = context;

      // Embed query + rank chunks. A personal assistant shouldn't
      // refuse to answer just because the embedding endpoint is
      // down — degrade to "no notes grounding" and still answer
      // from tasks + calendar + memory + general knowledge.
      // Notes RAG core: embed → rank/MMR → graph-augment → second-hop. See
      // ask-note-retrieval.ts. `scored`/`notesUnavailable` stay reassignable —
      // ad-hoc grounding and contact dedup both mutate `scored`, and ad-hoc
      // grounding clears `notesUnavailable`.
      const askStages = createStageTimer();
      const retrieval = await retrieveAndRankNotes({
        embedModel,
        indexFiles: index.files,
        json: options.json === true,
        notesDir,
        onStderr: (text) => { io.stderr(text); },
        query,
        scope: options.scope?.trim(),
        topK
      });
      let scored = retrieval.scored;
      let notesUnavailable = retrieval.notesUnavailable;
      const { queryVec, splitClauses, subqueryEmbeddings } = retrieval;
      // The "open to verify" target for an AD-HOC grounding source whose receipt
      // would otherwise point at a fabricated `.muse/notes/<source>` path: the
      // real URL for a `--url` answer (openable), or `null` for an ephemeral
      // `--clipboard` answer (nothing to open). Notes / files keep their local path.
      const adHocVerifyTargets = new Map<string, string | null>();
      // `applyAdHocGrounding` pushes into `scored` IN PLACE (the array `retrieval.scored`
      // and `scored` share the same reference) — snapshot the pre-push length so the
      // plain-path seam call below can isolate just the newly-pushed ad-hoc entries as
      // `extras.extraChunks` instead of double-counting the real retrieval hits (the
      // seam re-retrieves those itself).
      const preAdHocChunkCount = scored.length;

      const adHoc = await applyAdHocGrounding({
        adHocVerifyTargets,
        notesUnavailable,
        onStderr: (text) => { io.stderr(text); },
        options,
        query,
        scored
      });
      notesUnavailable = adHoc.notesUnavailable;

      // Second-brain grounding: past-session episodes (auto-refreshed + untrusted-
      // tagged), recent feed headlines, and the user's own reflections. Each store
      // is optional + fail-soft. See ask-session-grounding.ts.
      const { browsingBlock, browsingHits, episodeBlock, episodeHits, feedBlock, feedHeadlines, reflectionBlock, reflectionLines, untrustedEpisodeIds } =
        await buildSessionFeedReflectionGrounding({
          autoReindex: options.autoReindex !== false,
          embedModel,
          onStderr: (text) => { io.stderr(text); },
          queryVec,
          queryText: query,
          topK
        });

      // Build assembly + chat-only fast path. Gated actuator tools
      // (--actuators), default browser control, the @muse/fs read/write
      // suite + web_download, and the messaging draft-first approval gate —
      // all conditional on --with-tools / --actuators. See ask-tool-wiring.ts.
      const { browserControllerToRelease, extraTools, messagingApprovalGate, screenVision, useActuators } =
        await buildAskToolWiring({ io, options, userKey });
      // Codex delegation routing (opt-in, OFF by default). An explicit
      // `--model codex/...` pins codex for THIS ask; otherwise a recorded AND
      // ready delegation choice (~/.muse/codex.json + `codex login`) routes the
      // effective model to codex. Not ready ⇒ fall back to the local default and
      // surface the setup steps. Must run BEFORE the assembly (which reads env).
      if (options.model && parseModelName(options.model).providerId === CODEX_PROVIDER_ID) {
        process.env.MUSE_MODEL = options.model;
        process.env.MUSE_MODEL_PROVIDER_ID = CODEX_PROVIDER_ID;
      } else if (options.model === undefined) {
        const activation = await resolveCodexActivation().catch(() => undefined);
        if (activation?.active && activation.model) {
          applyCodexModelToEnv(process.env, activation.model);
        } else if (activation && !activation.active && activation.setupSteps) {
          io.stderr(`(codex delegation is configured but not ready — using the local default)\n${activation.setupSteps}\n`);
        }
      }
      const assembly = createMuseRuntimeAssembly({
        ...(extraTools ? { extraTools } : {}),
        ...(messagingApprovalGate ? { messagingApprovalGate } : {})
      });
      if (!assembly.modelProvider || !(options.model ?? assembly.defaultModel)) {
        io.stderr("muse ask requires a configured model. Set MUSE_MODEL or pass --model.\n");
        process.exitCode = 2;
        return;
      }
      const baseModel = options.model ?? assembly.defaultModel!;
      const tierRoute = options.tiered && options.model === undefined
        ? routeAskTierModel(query, baseModel, process.env)
        : undefined;
      const model = tierRoute?.model ?? baseModel;
      if (tierRoute) {
        io.stderr(`(tier: ${tierRoute.tier} → ${model})\n`);
      }
      // A FAILED ask must still leave a success:false run-log trace —
      // without it scout-signals / doctor failRate see zero ask-failure signal,
      // though chat-repl already writes one. Best-effort: a logging failure never
      // masks the real error, and every failure path returns before the success
      // trace at the end of the run, so there's no double-write.
      const writeAskFailureLog = async (failure: string): Promise<void> => {
        await writeRunLog(io.workspaceDir ?? process.cwd(), buildAskRunLog({
          query,
          model,
          timings: askStages.timings(),
          grounded: null,
          response: "",
          success: false,
          toolsUsed: [],
          errorMessage: failure
        })).catch(() => undefined);
      };
      // Vision surface may run a dedicated model (MUSE_VISION_MODEL, else the
      // measured local vision default when the chat model IS the local default).
      // Fail-soft to `model` when the optional vision model isn't pulled.
      const visionModel = await resolveSessionVisionModel(model, process.env as MuseEnvironment);
      if (visionModel !== model) {
        io.stderr(`(vision: ${visionModel})\n`);
      }
      if (assembly.modelProvider) {
        const visionProvider = assembly.modelProvider;
        screenVision.current = (input) =>
          describeImage(visionProvider, {
            imageBase64: input.imageBase64,
            mimeType: input.mimeType,
            model: visionModel,
            ...(input.question ? { question: input.question } : {})
          });
      }

      // Grounded vision actions: --extract / --to-calendar read the IMAGE (not
      // notes) and emit structured output / a draft action, so they short-circuit
      // the normal recall+grounding flow. Both require --image.
      if (options.extract || options.toCalendar || options.auto) {
        await runVisionCommandAction({
          imageAttachments,
          io,
          model: visionModel,
          modelProvider: assembly.modelProvider,
          options,
          userKey
        });
        return;
      }

      const userMemory = await Promise.resolve(assembly.userMemoryStore.findByUserId(userKey));
      const personaPrompt = userMemory ? buildMusePersona(userMemory, userKey) : undefined;
      const { loadActivePersonaPreamble } = await import("./persona-store.js");
      const personaTemplatePreamble = await loadActivePersonaPreamble();

      // Externally-ingested (untrusted) note paths — hoisted here so BOTH the
      // note-context block's conflict marker (below) AND the grounding-evidence
      // tagging (further down) read the same set: a conflict pitting an ingested
      // note against the user's own is rendered trust-aware (prefer your own),
      // not a neutral "either could be current" (GROUNDED≠TRUE ask-path parity).
      const untrustedNoteSources = untrustedNotePaths(
        await readNoteProvenance(resolveNoteProvenanceFile(process.env as MuseEnvironment))
      );
      // `muse ask --with-tools` builds its own context block + system prompt
      // inline; the plain chat-only path composes the SAME work through
      // `runGroundedRecall`'s seam further down. See ask-context-assembly.ts
      // for the retrieval-refinement + grounding-block assembly this pulls in
      // (dedup→reorder→demoteStale→CRAG framing, personal-store / user-memory
      // / activity / playbook grounding, and the shared banner + system-prompt
      // + citation-normalizer builders both paths below consume).
      const assembled = await assembleAskContext({
        askStages,
        assembly,
        browsingBlock,
        browsingHits,
        embedModel,
        episodeBlock,
        episodeHits,
        feedBlock,
        feedHeadlines,
        io,
        options,
        personaPrompt,
        personaTemplatePreamble,
        query,
        reflectionBlock,
        reflectionLines,
        userKey,
        userMemory
      });
      let systemPrompt = "";
      const {
        matchedContacts, openTasks, pendingReminders, upcomingEvents,
        allMemoryFacts, matchedMemories,
        matchedActions, matchedCommands, matchedCommits,
        playbookSection, appliedStrategy, appliedStrategyId, probationSuggestion,
        printGroundedBanner, announceGenerating, webSearchPolicy,
        askRunId, leaseFile, acquireLease,
        nonNoteCitations, buildFullSystemPrompt, normalizeAskCitations
      } = assembled;
      let { collectedAnswer, answerLogprobs, toolsUsed, allowedNotes, citationAllowed, preRefusalStrippedCitations, agentGroundingSources, decompositionSignals } = assembled;
      // Isolate the ad-hoc (--file/--url/--clipboard) hits pushed onto `scored`
      // (see `preAdHocChunkCount` above) — both branches below fold these into
      // the seam's retrieval as `extras.extraChunks` so they cite exactly like
      // a retrieved note, instead of double-counting the real retrieval hits
      // the seam re-retrieves itself.
      const adHocChunks: readonly ScoredChunk[] = scored.slice(preAdHocChunkCount);
      if (options.withTools) {
        // `--with-tools` now converges onto the SAME `@muse/recall` seam the
        // plain chat-only path uses (`prepareGroundedRecall` — the prepare-only
        // half of `streamGroundedRecall`) instead of a hand-maintained
        // dedup→reorder→demoteStale→context-block copy, so both paths' note
        // retrieval stay byte-identical to the API/MCP callers of that pipeline.
        const prepared = await prepareGroundedRecall({
          embedFn: (t, m) => embed(t, m),
          extras: {
            composeSystemPrompt: (a) => buildFullSystemPrompt({ contextBlock: a.contextBlock, notesFraming: a.framing }),
            extraChunks: adHocChunks,
            notesUnavailableContextBlock: "(notes search unavailable this turn — answer from the other grounding sources)",
            refineChunks: true,
            untrustedNoteSources
          },
          options: { embedModel, scope: options.scope?.trim(), topK },
          query,
          sources: { notesDir, notesIndexFile: notesIndexPath() }
        });
        systemPrompt = prepared.systemPrompt;
        scored = [...prepared.scored];
        printGroundedBanner(scored, prepared.verdict);
        announceGenerating();
        await acquireLease();
        // Agent-runtime path — tools (muse.search, muse.notes.*,
        // muse.tasks.*, etc.) are exposed to the model and tool calls
        // get full round-trip execution. Slower (every tool round is
        // an extra request) but unlocks fresh-web answers + side-
        // effecting actions from a single `muse ask` shot.
        if (!assembly.agentRuntime) {
          io.stderr("(--with-tools requires a configured agent runtime — set MUSE_MODEL or provider key and re-run)\n");
          await writeAskFailureLog("--with-tools requires a configured agent runtime");
          process.exitCode = 1;
          return;
        }
        // Recall is read-only for durable memory: never let the agent save
        // its own assertions as "facts you told me" (provenance fabrication).
        // Two vectors, both closed: the remember_fact TOOL (forbidden) and
        // the after-complete auto-extract HOOK (skipped) — see
        // RECALL_FORBIDDEN_TOOL_NAMES and readSkipAutoExtract.
        const askMetadata = {
          runId: askRunId,
          userId: userKey,
          forbiddenToolNames: [...RECALL_FORBIDDEN_TOOL_NAMES],
          skipUserMemoryAutoExtract: true,
          ...(resolveAskMaxTools(process.env) !== undefined ? { maxTools: resolveAskMaxTools(process.env) } : {}),
          ...(useActuators ? { localMode: true } : {}),
          ...(options.notesOnly ? { allowedToolNames: [...NOTES_ONLY_TOOL_ALLOWLIST] } : {}),
          ...(webSearchPolicy ? { webSearchPolicy } : {})
        };
        // Lead-worker fan-out: a complex multi-task request (never an image
        // ask) is split into independent sub-tasks, each its own run, then
        // synthesized. Merged grounding sources still flow through the citation
        // gate below, so a fabricated citation in the combined answer is
        // stripped exactly as on the single-run path.
        const useDecomposition = imageAttachments.length === 0 && shouldDecompose(query).decompose;
        try {
          if (useDecomposition) {
            const decomposed = await runDecomposedAgentAsk({
              embed: (t) => embed(t, embedModel),
              metadata: askMetadata,
              model,
              query,
              runner: assembly.agentRuntime,
              systemPrompt
            });
            // An all-sub-tasks-failed decomposition returns "" (the seam's
            // documented fail-closed contract) — never print that verbatim
            // (blank output, and answerIsRefusal("") is false so the honest-
            // refusal UX below would silently skip too). Convert to an
            // explicit refusal so citation gate + refusal UX both fire.
            collectedAnswer = decomposedAnswerOrRefusal(decomposed.answer);
            toolsUsed = [...decomposed.toolsUsed];
            agentGroundingSources = [...decomposed.groundingSources];
            // Hoist the fan-out trust signals so the --json payload + run-log can read
            // them (the human stderr path below can't reach the machine surface).
            decompositionSignals = decompositionJsonFields(decomposed).decomposition;
            if (!options.json && decomposed.decomposed) {
              const capNote = decomposed.reason.includes("capped") ? " — extra items were dropped" : "";
              const incompleteNote = decomposed.synthesisIncomplete && decomposed.synthesisIncomplete.length > 0 ? " — ⚠ some sub-results may be missing; ask me to expand" : "";
              io.stderr(`(decomposed into ${decomposed.subtaskCount} sub-tasks${capNote}${incompleteNote})\n`);
            }
            if (!options.json) {
              for (const note of decompositionStderrNotes(decomposed)) io.stderr(`${note}\n`);
            }
          } else {
            const result = await assembly.agentRuntime.run({
              messages: [
                { content: systemPrompt, role: "system" },
                { content: query, role: "user", ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}) }
              ],
              metadata: askMetadata,
              model,
              runId: askRunId
            });
            collectedAnswer = result.response.output ?? "";
            toolsUsed = result.toolsUsed ?? [];
            agentGroundingSources = result.groundingSources ?? [];
          }
        } catch (cause) {
          await browserControllerToRelease?.disconnect().catch(() => { /* best-effort */ });
          // Same --json contract as the chat-only path: an agent
          // failure must be a parseable stdout object, not an
          // uncaught throw that leaves stdout empty.
          const rendered = renderAskStreamError({
            answer: collectedAnswer,
            error: cause instanceof Error ? cause.message : String(cause),
            json: options.json ?? false,
            model,
            query
          });
          if (rendered.stdout !== undefined) io.stdout(rendered.stdout);
          if (rendered.stderr !== undefined) io.stderr(rendered.stderr);
          await writeAskFailureLog(cause instanceof Error ? cause.message : String(cause));
          process.exitCode = 1;
          return;
        }
        await browserControllerToRelease?.disconnect().catch(() => { /* best-effort */ });
        if (!options.json && toolsUsed.length > 0) {
          io.stderr(`(tools used: ${toolsUsed.join(", ")})\n`);
        }
        // The answer is printed AFTER the citation gate below, so a fabricated
        // citation is stripped before the user sees it (this path buffers; the
        // chat-only path streams live and is warned post-hoc instead).

        // Strip a "cite as:" label the small model echoed from the note marker
        // before it reaches the gate, the receipts, and the buffered display.
        collectedAnswer = stripEchoedCiteAs(collectedAnswer);

        // Output-side grounding gate — the recall WEDGE's code-not-model half:
        // strip any citation the answer makes — a note, feed, task, event,
        // reminder, or session — that is NOT among the real sources, so a
        // fabricated citation can never reach the user (mirrors parseReflections
        // / parseCouncilAnswer for recall). The agent can pull MORE notes via
        // knowledge_search, so its allowed notes are the whole live corpus —
        // any real note file is fair, only a non-existent one is invented.
        allowedNotes = index ? filterLiveNoteIndexFiles(index.files, existsSync).map((f) => relativizeNoteSource(f.path, notesDir)) : [];
        collectedAnswer = normalizeAskCitations(collectedAnswer);
        citationAllowed = { ...nonNoteCitations, notes: allowedNotes };
        const citationGate = enforceAnswerCitations(collectedAnswer, citationAllowed);
        // Every sentence can be dropped as un-groundable (the citation-gate
        // clause-leak fix) — an empty string there would read as a silent bug, not
        // an honest abstention, so surface the SAME fixed hedge every other refusal
        // uses instead of a blank answer.
        collectedAnswer = withUngroundableFallback(citationGate);
        preRefusalStrippedCitations = citationGate.stripped;
      } else {
        // Chat-only fast path, now routed through `runGroundedRecall`'s seam
        // (`streamGroundedRecall`) — the SAME retrieval→dedup→reorder→context-
        // block→prompt→generate→citation-gate pipeline the API/MCP callers use.
        // `extras` reproduces this path's own prompt shape via `composeSystemPrompt`
        // (`buildFullSystemPrompt` above), its citation-normalization passes via
        // `normalizeAnswer` (`normalizeAskCitations` above), and folds any ad-hoc
        // (--file/--url/--clipboard) passage in as `extraChunks` so it cites
        // exactly like a retrieved note.
        const extras: GroundedRecallExtras = {
          allowedCitations: nonNoteCitations,
          // Captured into the outer `systemPrompt` too — `runGroundingVerdict`'s
          // --repair/--best-of regeneration reads it to redraft with the SAME
          // context a plain re-ask would have used.
          composeSystemPrompt: (args) => {
            systemPrompt = buildFullSystemPrompt({ contextBlock: args.contextBlock, notesFraming: args.framing });
            return systemPrompt;
          },
          extraChunks: adHocChunks,
          normalizeAnswer: normalizeAskCitations,
          refineChunks: true,
          untrustedNoteSources
        };

        let streamError: string | undefined;
        let logprobsCapture: AskStreamResult["logprobs"];
        // withSigintAbort so Ctrl-C exits 130 instead of leaving the stream
        // pump dangling on the adapter side; the seam's live citation filter
        // covers the SAME "never flash a fabricated source" guarantee
        // `streamCiteFilter` used to provide inline.
        await withSigintAbort(async (signal) => {
          try {
            const events = streamGroundedRecall({
              extras,
              options: {
                answerModel: model,
                embedModel,
                scope: options.scope?.trim(),
                temperature: resolveAnswerTemperature(process.env as MuseEnvironment),
                topK
              },
              query,
              runtime: {
                embedFn: (text, embedM) => embed(text, embedM),
                // Only reached when the provider has no streaming path — the
                // seam's documented single-shot degrade.
                generateAnswer: async (args) => {
                  const res = await assembly.modelProvider!.generate({
                    messages: [
                      { content: composeChatSystemContent(args.system, playbookSection), role: "system" },
                      { content: args.user, role: "user", ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}) }
                    ],
                    model: args.model,
                    ...(args.temperature !== undefined ? { temperature: args.temperature } : {})
                  });
                  return res.output ?? "";
                },
                streamAnswer: async function* (args) {
                  for await (const event of assembly.modelProvider!.stream({
                    messages: [
                      { content: composeChatSystemContent(args.system, playbookSection), role: "system" },
                      { content: args.user, role: "user", ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}) }
                    ],
                    // Observational confidence instrumentation (frontier F1): opt-in,
                    // never alters decoding; summarized onto the run-log trace below.
                    ...(process.env.MUSE_LOGPROBS === "1" || process.env.MUSE_LOGPROBS === "true" ? { logprobs: true } : {}),
                    ...(webSearchPolicy ? { metadata: { webSearchPolicy } } : {}),
                    model: args.model,
                    // Ctrl-C aborts the in-flight HTTP call itself (Ollama stops
                    // generating), not just the client-side chunk loop.
                    signal,
                    ...(args.temperature !== undefined ? { temperature: args.temperature } : {})
                  }) as AsyncIterable<AskStreamEvent>) {
                    if (signal.aborted) return;
                    if (event.type === "error") {
                      throw new Error(event.error?.message ?? "model request failed");
                    }
                    if (event.type === "text-delta" && typeof event.text === "string") {
                      yield event.text;
                    }
                    if (event.type === "done" && event.response?.logprobs && event.response.logprobs.length > 0) {
                      logprobsCapture = event.response.logprobs;
                    }
                  }
                }
              },
              sources: { notesDir, notesIndexFile: notesIndexPath() }
            });
            for await (const event of events) {
              if (signal.aborted) break;
              if (event.type === "retrieval") {
                // Fires BEFORE generation — same ordering as --with-tools
                // (banner → "generating…" → tokens).
                scored = [...event.scored];
                printGroundedBanner(scored, event.verdict);
                announceGenerating();
                await acquireLease();
              } else if (event.type === "answer-delta") {
                if (!options.json) io.stdout(event.text);
              } else if (event.type === "result") {
                collectedAnswer = event.result.answer;
                allowedNotes = [...new Set(event.result.scored.map((r) => relativizeNoteSource(r.file, notesDir)))];
                citationAllowed = { ...nonNoteCitations, notes: allowedNotes };
                preRefusalStrippedCitations = event.result.preRefusalStrippedCitations;
              }
            }
          } catch (cause) {
            streamError = cause instanceof Error ? cause.message : String(cause);
          }
        }, { onSigint: () => { if (!options.json) io.stderr("\n(Ctrl-C — aborting…)\n"); } });
        answerLogprobs = logprobsCapture;
        if (streamError !== undefined) {
          const rendered = renderAskStreamError({
            answer: collectedAnswer,
            error: streamError,
            json: options.json ?? false,
            model,
            query
          });
          if (rendered.stdout !== undefined) io.stdout(rendered.stdout);
          if (rendered.stderr !== undefined) io.stderr(rendered.stderr);
          await writeAskFailureLog(streamError);
          process.exitCode = 1;
          return;
        }
      }

      askStages.mark("generationMs");
      const refusalAnswer = answerIsRefusal(collectedAnswer);
      // The stripping always runs; the WARNING is suppressed for (a) an action
      // request, where the model citing the tool name (`muse.reminders.add`) as a
      // "source" is a harmless quirk on a successful action, and (b) a REFUSAL,
      // which asserts no claim — "Removed a citation, treat those claims as
      // unverified" is nonsensical when the answer is "I don't have that" (and the
      // spurious citation is dropped anyway by the refusal guard below). The text
      // is still cleaned either way — the spurious token never reaches the user.
      if (shouldWarnStrippedCitations({ isActionRequest: classifyActionRequest(query), isRefusal: refusalAnswer, json: Boolean(options.json), strippedCount: preRefusalStrippedCitations.length })) {
        io.stderr(`\n⚠️  Removed ${preRefusalStrippedCitations.length.toString()} citation(s) to source(s) you don't have (${preRefusalStrippedCitations.join(", ")}) — treat those claims as unverified.\n`);
      }
      // Refusal guard: a refusal asserts no grounded fact, so any citation the
      // model tacked on is spurious — strip ALL of them (and thus the Sources
      // footer) so a refusal never points the user at a source "to verify".
      // Generation done — free the Ollama lease (best-effort; process exit
      // also frees it for the daemon since a dead pid is ignored).
      try {
        await releaseOllamaLease(leaseFile, process.pid);
      } catch { /* best-effort */ }
      if (refusalAnswer) {
        collectedAnswer = withUngroundableFallback(enforceAnswerCitations(collectedAnswer, {
          events: [], feeds: [], notes: [], reminders: [], sessions: [], tasks: []
        }));
      }
      // The --with-tools answer was buffered (not streamed), so it prints HERE
      // — after the gate — so a fabricated citation is stripped before display.
      if (options.withTools && !options.json) {
        io.stdout(collectedAnswer);
      }

      // The "shows its work" source receipts are rendered AFTER the grounding
      // verdict below, and ONLY when the answer passed it — a receipt on an
      // ungrounded answer lends false authority to a fabrication (the edge
      // showing work for work that failed its own check).

      // Discoverability: when Muse REFUSED and the question is plainly about git
      // or shell history, point the user at the opt-in flag that would answer it
      // — otherwise these sources are invisible (the user never learns they exist).
      if (!options.json && refusalAnswer) {
        const tip = suggestOptInSource(query, { git: options.git === true, shell: options.shell === true });
        if (tip) io.stderr(`${tip}\n`);
      }

      // Output-side rubric VERDICT — the recall edge's drift gate, now under
      // BOTH the chat-only AND the --with-tools agent path (one gate under EVERY
      // surface): even after invented citations are stripped, warn when the
      // answer's claims drift beyond the grounded passages — the fabrication
      // signal the citation gate alone can't see. The ambiguous `weak` band
      // spends ONE extra local-Qwen inference (MaTTS) to re-check the answer
      // against the evidence — fail-close, so a judge error still warns.
      const verdict = await runGroundingVerdict({
        adHocVerifyTargets,
        agentGroundingSources,
        allMemoryFacts,
        allowedNotes,
        browsingHits,
        citationAllowed,
        collectedAnswer,
        embedModel,
        episodeHits,
        feedHeadlines,
        imageAttachments,
        index,
        io,
        matchedActions,
        matchedCommands,
        matchedCommits,
        matchedContacts,
        model,
        notesDir,
        openTasks,
        options,
        pendingReminders,
        playbookSection,
        provider: assembly.modelProvider,
        query,
        refusalAnswer,
        scored,
        systemPrompt,
        untrustedEpisodeIds,
        untrustedNoteSources,
        upcomingEvents
      });
      collectedAnswer = verdict.collectedAnswer;
      const groundedVerdictLabel = verdict.groundedVerdictLabel;
      const sourceCheck = verdict.sourceCheck;
      // What retrieval surfaced (top sources + cosine) for the run-log trace, so
      // "why this answer / which sources ranked" is answerable locally (P1.2).
      const askRetrieval = verdict.askRetrieval;

      await finalizeAndRenderAsk({
        answerLogprobs,
        appliedStrategy,
        appliedStrategyId,
        askRetrieval,
        askRunId,
        askStages,
        citationGate: { stripped: preRefusalStrippedCitations },
        collectedAnswer,
        decompositionSignals,
        embedModel,
        episodeHits,
        groundedVerdictLabel,
        io,
        matchedMemories,
        model,
        noteFileCount,
        notesDir,
        openTasks,
        options,
        pendingReminders,
        probationSuggestion,
        query,
        refusalAnswer,
        scored,
        sourceCheck,
        splitClauses,
        subqueryEmbeddings,
        toolsUsed,
        upcomingEvents
      });
    });
}
