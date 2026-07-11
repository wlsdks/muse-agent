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
import { readFile } from "node:fs/promises";

import { detectEvidenceContradictions, enforceAnswerCitations, isInjectableStrategy, lexicalTokens, normalizeContactCitations, normalizeFromPrefixedCitations, normalizeMemoryCitations, normalizeSlotCitations, renderPlaybookSection, reorderForLongContext, withUngroundableFallback, type ContradictionPair } from "@muse/agent-core";
import { describeImage } from "@muse/agent-core";
import { classifyActionRequest, classifyCorpusOverview, isMemoryInjection } from "@muse/agent-core";
import { contestedFactKeys, defaultBeliefProvenanceFile, deriveFactProvenance, FileBeliefProvenanceStore, normalizeMemoryKey, provisionalFactKeys, staleFactKeys } from "@muse/memory";
import { createMuseRuntimeAssembly, resolveAnswerTemperature, resolveNoteProvenanceFile, resolveNotesDir, resolveNotesIndexFile, resolvePendingApprovalsFile, type MuseEnvironment } from "@muse/autoconfigure";
import { readNoteProvenance, untrustedNotePaths } from "./note-provenance.js";
import type { MuseTool } from "@muse/tools";
import { acquireOllamaLease, releaseOllamaLease, resolveOllamaLeaseFile } from "@muse/stores";
import { type MessageApprovalGate } from "@muse/domain-tools";

import { createRunId } from "@muse/shared";
import { allUserMemoryFacts, buildMemoryContextBlock, buildNoteContextBlock, collectCitedNoteAges, contactGroundingEvidence, contactMatchScore, filterNotesByScope, formatCoarseAge, formatContactBirthday, formatNonNoteReceipts, formatSourceReceipts, formatSourcesFooter, formatStalenessWarning, groundingSectionLines, provenanceDate, provenanceSnippet, relativizeNoteSource, relevantSnippet, renderMemoryFact, selectMemoryFacts } from "@muse/recall";
export { allUserMemoryFacts, collectCitedNoteAges, contactGroundingEvidence, contactMatchScore, filterNotesByScope, formatCoarseAge, formatContactBirthday, formatNonNoteReceipts, formatSourceReceipts, formatSourcesFooter, formatStalenessWarning, groundingSectionLines, provenanceDate, provenanceSnippet, relativizeNoteSource, relevantSnippet, renderMemoryFact, selectMemoryFacts };
import { answerIsRefusal, composeChatSystemContent, corpusOnboardingHint, formatCorpusOverview, formatGraphLinksSection, looksLikeBinaryContent, queryHasAdHocGrounding, shouldWarmClose, stripEchoedCiteAs, stripGroundingFences, sufficiencyAdvisory, urlGroundingSource } from "@muse/recall";
export { answerIsRefusal, composeChatSystemContent, corpusOnboardingHint, formatCorpusOverview, formatGraphLinksSection, looksLikeBinaryContent, queryHasAdHocGrounding, shouldWarmClose, stripEchoedCiteAs, sufficiencyAdvisory, urlGroundingSource };
import { shouldSuggestRepair, shouldWarnStrippedCitations, suggestOptInSource } from "@muse/recall";
export { shouldSuggestRepair, shouldWarnStrippedCitations, suggestOptInSource };
import { augmentNoteEvidenceWithCited, selectFilePassages, selectGroundingActions, selectPlaybookSection, selectProbationSuggestion, topAppliedStrategy } from "@muse/recall";
export { augmentNoteEvidenceWithCited, selectFilePassages, selectGroundingActions, selectPlaybookSection, selectProbationSuggestion, topAppliedStrategy };
import { dedupNearDuplicateChunks, demoteStale, diversifyAskChunks, notesGroundingFraming } from "@muse/recall";
import { groundedSourceSummary } from "@muse/recall";
import { streamGroundedRecall, type GroundedRecallExtras, type ScoredChunk } from "@muse/recall";

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
import type { FileEntry } from "@muse/recall";


import { CODEX_PROVIDER_ID, parseModelName } from "@muse/model";
import { applyCodexModelToEnv, resolveCodexActivation } from "./codex-cli.js";
import { routeAskTierModel } from "./ask-tier-models.js";
import { shouldDecompose } from "@muse/multi-agent";
import { decomposedAnswerOrRefusal, runDecomposedAgentAsk } from "./ask-decompose.js";
import { tryDeterministicAnswer } from "./ask-fast-paths.js";
export { CASUAL_RESPONSES, META_RESPONSE, ACTION_GUIDE } from "./ask-fast-paths.js";
import { decompositionJsonFields, decompositionStderrNotes, renderAskStreamError, type AskStreamEvent, type AskStreamResult, type DecompositionTrustSignals } from "./ask-result-output.js";
export { decompositionJsonFields, decompositionStderrNotes, renderAskStreamError, type AskStreamEvent, type AskStreamResult } from "./ask-result-output.js";
import { rescueMemoryCrossLingual } from "./ask-cross-lingual.js";

export { resolveAskTierModels, routeAskTierModel } from "./ask-tier-models.js";
import { parseBoundedInt } from "./parse-bounded-int.js";
import type { Command } from "commander";

import { cosine, isNotesIndexStale, reindexNotes } from "./commands-notes-rag.js";
import { filterLiveNoteIndexFiles } from "./commands-recall.js";
import { embed } from "./embed.js";
import { rankPlaybookEntriesByRelevance } from "./playbook-embed-rank.js";
import { buildAskRunLog, resolvePersona, writeRunLog } from "./program-helpers.js";
import { buildMusePersona } from "./muse-persona.js";
import { readPipedStdin } from "./chat-repl.js";
import type { ProgramIO } from "./program.js";
import { withSigintAbort } from "./sigint-abort.js";
import { resolveDefaultUserKey } from "./user-id.js";
import { listNoteFiles, notesCorpusFileCount, resolveAskMaxTools, selectGraphConnections } from "./ask-corpus-helpers.js";
import { userHasOtherPersonalData } from "./ask-user-data-presence.js";
import { collectAutoImageAttachments, loadImageAttachment } from "./ask-image-attachments.js";
import { CITATION_INSTRUCTION_LINES } from "./ask-prompt-constants.js";
import { buildSessionFeedReflectionGrounding } from "./ask-session-grounding.js";
import { retrieveAndRankNotes } from "./ask-note-retrieval.js";
import { applyAdHocGrounding } from "./ask-adhoc-grounding.js";
import { resolveSessionVisionModel, runVisionCommandAction } from "./ask-vision-command.js";
import { runGroundingVerdict } from "./ask-grounding-verdict.js";
import { buildAskSystemPrompt } from "./ask-system-prompt.js";
import { finalizeAndRenderAsk } from "./ask-finalize.js";
import { buildActivityGrounding } from "./ask-activity-grounding.js";
import { buildPersonalStoreGrounding } from "./ask-personal-store-grounding.js";
import { DEFAULT_EMBED_MODEL, resolveIndexModel } from "./embed-model-default.js";
















interface AskOptions {
  readonly user?: string;
  readonly persona?: string;
  readonly model?: string;
  readonly image?: string;
  readonly autoImage?: boolean;
  readonly extract?: string;
  readonly toCalendar?: boolean;
  readonly auto?: boolean;
  readonly apply?: boolean;
  readonly top?: string;
  readonly embedModel?: string;
  readonly autoReindex?: boolean;
  readonly tasks?: boolean;
  readonly calendar?: boolean;
  readonly calendarDays?: string;
  readonly reminders?: boolean;
  readonly contacts?: boolean;
  readonly actions?: boolean;
  readonly shell?: boolean;
  readonly git?: boolean;
  readonly file?: string;
  readonly url?: string;
  readonly clipboard?: boolean;
  readonly scope?: string;
  readonly json?: boolean;
  readonly withTools?: boolean;
  readonly actuators?: boolean;
  readonly tiered?: boolean;
  readonly connect?: boolean;
  readonly repair?: boolean;
  readonly bestOf?: string;
  readonly why?: boolean;
  readonly verifyClaims?: boolean;
  /**
   * Clamps the answer to notes + local-memory grounding only.
   * Disables native web_search on every provider path and, when
   * `--with-tools` is also set, allowlists the agent runtime to
   * muse.notes / muse.notes-multi / muse.context only.
   */
  readonly notesOnly?: boolean;
}

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



interface NotesIndex {
  readonly version: 1;
  readonly model: string;
  readonly files: readonly FileEntry[];
}

function notesIndexPath(): string {
  return resolveNotesIndexFile(process.env as Record<string, string | undefined>);
}

function defaultUserKey(user: string | undefined, persona: string | undefined): string {
  const base = resolveDefaultUserKey({ override: user });
  const resolved = resolvePersona(persona);
  return resolved ? `${base}@${resolved}` : base;
}

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
  program
    .command("ask")
    .description("Ask a question with your notes as context — RAG-grounded one-shot via local Qwen. Reads piped stdin too: `cat doc.md | muse ask 'summarize this'`")
    .argument("[query...]", "Free-text question (omit to read entire query from stdin)")
    .addHelpText("after", `
Examples:
  $ muse ask "what did I decide about pricing?"      # grounded one-shot from your notes
  $ muse ask --scope work "who owns the roadmap?"    # ground only on the work/ folder
  $ muse ask --why "when is the launch?"             # show WHY an answer was refused/flagged
  $ muse ask --image receipt.jpg --auto              # SEE an image and draft the matching action`)
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .option("--model <tag>", "Chat model override")
    .option("--top <k>", "Top-K notes chunks to inject as context (default 3)", "3")
    .option("--embed-model <tag>", "Embedding model (must match the index)", DEFAULT_EMBED_MODEL)
    .option(
      "--no-auto-reindex",
      "Skip the auto-stale check before search (default: reindex incrementally when a note's mtime is newer than the index)"
    )
    .option(
      "--no-tasks",
      "Skip injecting open tasks as grounding context (default: include open tasks alongside notes so 'what should I focus on?' answers correctly)"
    )
    .option(
      "--no-calendar",
      "Skip injecting upcoming calendar events as grounding context (default: include events from the configured providers)"
    )
    .option(
      "--calendar-days <n>",
      "Window (in days from now) to pull calendar events into context (default 7)",
      "7"
    )
    .option(
      "--no-reminders",
      "Skip injecting pending reminders as grounding context (default: include pending reminders sorted by due date)"
    )
    .option(
      "--no-contacts",
      "Skip injecting matching contacts as grounding context (default: include contacts whose name/alias/email matches the question)"
    )
    .option(
      "--no-actions",
      "Skip injecting matching action-log entries (default: include what Muse has done on your behalf so 'did you send that?' / 'what have you done?' answer from the real log)"
    )
    .option(
      "--shell",
      "OPT-IN: also ground on matching commands from your shell history (secret-redacted, local-only; default OFF because history is sensitive). Set $MUSE_SHELL_HISTORY_FILE / $HISTFILE to override the source."
    )
    .option(
      "--git",
      "OPT-IN: also ground on your recent git commits in the current repo (read from .git/logs/HEAD, local-only). Answers 'what did I work on?' / 'what was that commit?'. Set $MUSE_GIT_REFLOG_FILE to override the source."
    )
    .option(
      "--file <path>",
      "Ground this answer on a specific file WITHOUT ingesting it into your notes corpus (read-only). The answer cites it as [from <path>]; an off-topic question still honestly refuses."
    )
    .option(
      "--url <url>",
      "Ground this answer on a public web page's readable text WITHOUT ingesting it (read-only fetch). The answer cites it as [from <host>]; an off-topic question still honestly refuses."
    )
    .option(
      "--clipboard",
      "Ground this answer on whatever text you just copied to your clipboard (read-only, local). The answer cites it as [from clipboard]; an off-topic question still honestly refuses. Great for 'I copied this — what does it mean?' without saving a file."
    )
    .option(
      "--scope <folder>",
      "Ground only on notes under this top-level folder, e.g. --scope work — grounds the answer in just that collection instead of the whole corpus (less cross-domain noise). An unknown/empty folder grounds on nothing (honest refusal)."
    )
    .option(
      "--json",
      "Emit a single JSON object on stdout with {query, model, answer, grounded:{...}} (suppresses streaming)"
    )
    .option(
      "--with-tools",
      "Run through the agent runtime so the model can call MCP tools (muse.search, muse.notes.*, muse.tasks.*, etc.). Default off — the chat-only fast path streams ~2x faster but can't fetch fresh web data."
    )
    .option(
      "--actuators",
      "With --with-tools, expose the gated state-changing actuators (email_send, web_action, home_action) so the conversation can trigger them. Each action shows the exact draft and fires only after you confirm. Off by default; providers resolve from env (MUSE_GMAIL_TOKEN, MUSE_HOMEASSISTANT_URL/TOKEN)."
    )
    .option(
      "--notes-only",
      "Clamp grounding to local notes + memory only — disables native web_search on every provider path and, when combined with --with-tools, allowlists the agent runtime to muse.notes / muse.notes-multi / muse.context only."
    )
    .option(
      "--connect",
      "After the answer, surface a '💡 Related in your brain' footer of the strongest related notes / past sessions (second-brain connection, same as `muse today --connect`). Off by default; ignored with --json."
    )
    .option(
      "--tiered",
      "Route this ask to a fast or high-capability model by classifying the question (lookups → fast, reasoning → heavy; defaults to heavy when unsure). Tier models come from MUSE_FAST_MODEL / MUSE_HEAVY_MODEL (each defaults to the configured model). An explicit --model overrides tiering. Off by default."
    )
    .option(
      "--repair",
      "When an answer fails the grounding check, attempt ONE local rewrite constrained to your retrieved notes and show it as a 'Corrected from your notes' offer — but ONLY if the rewrite then re-verifies grounded (else the honest refusal stands; a fix is never fabricated). Off by default; spends one extra local inference."
    )
    .option(
      "--best-of <n>",
      "When an answer fails the grounding check, redraw up to n-1 fresh drafts and keep the best one the deterministic verifier grounds (confirmed by the full gate before it replaces the answer; no survivor = the honest warning stands). Raises the answered rate at the same fabrication=0. 2-5; off by default; spends up to n-1 extra local inferences. Chat-only path (--json/--image/--with-tools unaffected)."
    )
    .option(
      "--why",
      "When Muse refuses or flags an answer, show WHY — which grounding criterion fell short (confidence / coverage / answerability / citation) and the measured value vs its threshold (e.g. 'best match 0.42, I need 0.55'), so you can rephrase, reindex, or add a note. Silent on a confident, grounded answer."
    )
    .option(
      "--verify-claims",
      "Per-claim grounding (Self-RAG ISSUP): after a GROUNDED answer, re-check EACH atomic claim against your notes and surface only the trustworthy subset — so a single fabricated clause in an otherwise-grounded answer ('Mina owns pricing AND the budget was 2M') is flagged 'I'm not sure about …' instead of riding through. Opt-in, fail-open (a check error keeps the claim), never turns a good answer into a refusal; spends one extra local inference per claim."
    )
    .option(
      "--image <path>",
      "Attach a local image (PNG/JPEG/GIF/WebP/HEIC) for the model to SEE — runs locally on the multimodal default (gemma4). e.g. `muse ask --image receipt.jpg '이 영수증 정리해줘'`."
    )
    .option(
      "--auto-image",
      "Auto-attach local image paths mentioned in your message (path-safe + existing files only) so the model SEES them — no explicit --image needed. e.g. `muse ask --auto-image '~/Pictures/receipt.jpg 정리해줘'`."
    )
    .option(
      "--extract <fields>",
      "With --image: extract structured data for the comma-separated fields and print JSON (grounded — an unreadable field is omitted, never invented). e.g. `muse ask --image receipt.jpg --extract 'merchant,total,date'`."
    )
    .option(
      "--to-calendar",
      "With --image: extract a calendar event from the image and DRAFT it (title/startsAt/location/notes). Draft-first — prints the proposed event; re-run with --apply to actually create it. e.g. `muse ask --image flyer.jpg --to-calendar`."
    )
    .option(
      "--auto",
      "With --image: AUTO-detect the image kind (event / receipt / contact) and draft the matching action — calendar event, expense note, or new contact. Draft-first; re-run with --apply to perform it. e.g. `muse ask --image photo.jpg --auto`."
    )
    .option(
      "--apply",
      "With --to-calendar: actually create the extracted event (default is draft-only)."
    )
    .action(async (queryParts: readonly string[], options: AskOptions) => {
      const argQuery = queryParts.join(" ").trim();
      const piped = await (io.readPipedStdin ?? readPipedStdin)();

      // Composition follows the same idiom as `muse chat`:
      //   args + stdin → instruction first, content after
      //   args only     → use args
      //   stdin only    → treat stdin as the question
      //   neither       → usage error
      // Lets `cat doc.md | muse ask "summarize this"` work, plus
      // `echo "question?" | muse ask` for headless pipelines.
      let query: string;
      if (argQuery.length > 0 && piped.length > 0) {
        query = `${argQuery}\n\n${piped}`;
      } else if (argQuery.length > 0) {
        query = argQuery;
      } else if (piped.length > 0) {
        query = piped;
      } else if (options.image) {
        query = "Describe this image.";
      } else {
        io.stderr("usage: muse ask <query>   |   cat content | muse ask [optional-instruction]\n");
        process.exitCode = 1;
        return;
      }

      // Multimodal: load a local image so the model can SEE it (the runtime
      // carries `attachments` through to the Ollama adapter → gemma4 vision).
      let imageAttachments: ReadonlyArray<{ readonly mimeType: string; readonly dataBase64: string }> = [];
      if (options.image) {
        const loaded = await loadImageAttachment(options.image);
        if (!loaded.ok) {
          io.stderr(`${loaded.error}\n`);
          process.exitCode = 1;
          return;
        }
        imageAttachments = [loaded.attachment];
      }

      // --auto-image: attach image paths mentioned in the message itself, so a
      // user can drop a path inline without --image. Gated (path-safe + existing
      // + valid image bytes); a path that fails any check is silently skipped so
      // auto-detection never errors the ask. Augments any explicit --image.
      if (options.autoImage) {
        const auto = await collectAutoImageAttachments(query);
        if (auto.length > 0) {
          imageAttachments = [...imageAttachments, ...auto];
        }
      }

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

      const userKey = defaultUserKey(options.user, options.persona);
      const topK = parseBoundedInt(options.top, "--top", 1, 20, 3);
      const embedModel = options.embedModel ?? DEFAULT_EMBED_MODEL;

      // Auto-stale check + incremental reindex (default on). JARVIS
      // shouldn't make the user remember to run reindex; if a note
      // file is newer than the index, just refresh before search.
      const notesDir = resolveNotesDir(process.env as Record<string, string | undefined>);
      // Preserve the model the index was built with: a stale
      // refresh must NOT silently re-embed a custom-model index
      // with the default just because --embed-model was omitted.
      // The mismatch is still surfaced by the explicit guard below.
      let existingIndexModel: string | undefined;
      try {
        existingIndexModel = (JSON.parse(await readFile(notesIndexPath(), "utf8")) as NotesIndex).model;
      } catch {
        existingIndexModel = undefined;
      }
      if (options.autoReindex !== false) {
        try {
          const stale = await isNotesIndexStale(notesDir, notesIndexPath());
          if (stale) {
            const summary = await reindexNotes({
              dir: notesDir,
              indexPath: notesIndexPath(),
              // resolveIndexModel preserves a custom index model but migrates
              // the legacy default to the shipped multilingual default.
              model: resolveIndexModel(existingIndexModel, embedModel),
              // Stream per-file progress so a first ingest of a real
              // corpus (PDFs embed slowly on CPU) shows life instead of
              // a silent multi-second hang, and a skipped unreadable
              // file is visible rather than swallowed.
              onProgress: (line) => io.stderr(`  ${line}\n`)
            });
            if (summary.embedded > 0 || summary.failed > 0) {
              io.stderr(`(notes index refreshed: ${summary.embedded.toString()} embedded, ${summary.skipped.toString()} cached, ${summary.failed.toString()} skipped)\n`);
            }
          }
        } catch (cause) {
          io.stderr(`(auto-reindex skipped: ${cause instanceof Error ? cause.message : String(cause)})\n`);
        }
      }

      // Load notes index — soft-fail with hint if missing
      let index: NotesIndex | undefined;
      try {
        const raw = await readFile(notesIndexPath(), "utf8");
        index = JSON.parse(raw) as NotesIndex;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          io.stderr("No notes index at ~/.muse/notes-index.json. Run `muse notes reindex` first.\n");
          process.exitCode = 1;
          return;
        }
        throw cause;
      }
      if (index.model !== embedModel) {
        // One-time legacy migration: an index built with the OLD default
        // re-embeds with the new multilingual default instead of dead-ending —
        // otherwise the embedder upgrade would brick every existing install.
        // A CUSTOM index model still gets the explicit mismatch error.
        if (resolveIndexModel(index.model, embedModel) === embedModel && options.autoReindex !== false) {
          io.stderr(`(embedding default upgraded '${index.model}' → '${embedModel}' — re-indexing your notes once)\n`);
          try {
            await reindexNotes({ dir: notesDir, indexPath: notesIndexPath(), model: embedModel, onProgress: (line) => io.stderr(`  ${line}\n`) });
            index = JSON.parse(await readFile(notesIndexPath(), "utf8")) as NotesIndex;
          } catch (cause) {
            io.stderr(`Re-index failed (${cause instanceof Error ? cause.message : String(cause)}). Try: ollama pull ${embedModel}\n`);
            process.exitCode = 1;
            return;
          }
        }
        if (index.model !== embedModel) {
          io.stderr(`Index was built with embed model '${index.model}', not '${embedModel}'. Re-index or pass --embed-model ${index.model}.\n`);
          process.exitCode = 1;
          return;
        }
      }

      // First-run on-ramp: an empty corpus still answers honestly (refusal),
      // but a new user needs to be told HOW to add notes — emit it once here.
      // Gate on note FILES on disk, not indexed chunks: when embedding is
      // down the index has 0 live chunks though the user has notes, and
      // "your corpus is empty" would be a false message.
      const noteFileCount = await notesCorpusFileCount(notesDir);

      // A whole-corpus overview ("what's in my notes?", "list my notes") isn't a
      // top-K recall — every note matches weakly, so the gate would refuse and
      // the warm-close would tell a user WHO HAS NOTES to "add a note". Answer it
      // with the real inventory instead (deterministic, no model call, no
      // fabrication). Only when notes actually exist; empty corpus falls through
      // to the on-ramp.
      if (noteFileCount > 0 && classifyCorpusOverview(query)) {
        const overview = formatCorpusOverview(await listNoteFiles(notesDir), noteFileCount);
        if (options.json) {
          io.stdout(`${JSON.stringify({ corpusOverview: true, noteCount: noteFileCount, query })}\n`);
        } else {
          io.stdout(`${overview}\n`);
        }
        return;
      }

      // This query EXPLICITLY supplied its own grounding (a file, a URL, git, or
      // shell history) — the "add notes" on-ramp is irrelevant noise then.
      const hasAdHocGrounding = queryHasAdHocGrounding(options);
      // Only probe the other personal stores when notes ARE empty AND no ad-hoc
      // source was given (the only case the hint could fire) — so a notes-having
      // or source-supplying user pays no extra reads.
      const hasOtherPersonalData = !hasAdHocGrounding && noteFileCount === 0
        ? await userHasOtherPersonalData(userKey, process.env as Record<string, string | undefined>)
        : false;
      const onboardingHint = corpusOnboardingHint(noteFileCount, hasOtherPersonalData || hasAdHocGrounding);
      if (onboardingHint) {
        io.stderr(`${onboardingHint}\n`);
      }

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
      const { preGapScored, queryVec, splitClauses, subqueryEmbeddings } = retrieval;
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

      // Build assembly + chat-only fast path. `--actuators` (only
      // meaningful with --with-tools) injects the gated state-changing
      // actuator tools, each carrying a clack confirm as its
      // fail-closed gate.
      const useActuators = options.actuators === true && options.withTools === true;
      if (options.actuators === true && options.withTools !== true) {
        io.stderr("(--actuators has no effect without --with-tools)\n");
      }
      let extraTools: MuseTool[] | undefined;
      // mac_screen_read's vision callback resolves lazily through this holder:
      // the actuator tools are built BEFORE the assembly/model exist, but the
      // tool only ever runs long after both are set below.
      const screenVision: { current?: (input: { readonly imageBase64: string; readonly mimeType: string; readonly question?: string }) => Promise<{ readonly ok: boolean; readonly text?: string; readonly error?: string }> } = {};
      if (useActuators) {
        const actuatorMod = await import("./actuator-tools.js");
        const actuatorEnv = process.env as MuseEnvironment;
        io.stderr(actuatorMod.formatActuatorBanner(actuatorMod.summarizeActuators(actuatorEnv)));
        extraTools = actuatorMod.buildActuatorTools({
          describeScreenImage: async (input) =>
            screenVision.current ? screenVision.current(input) : { error: "the local vision model is not available in this run", ok: false },
          env: actuatorEnv,
          io,
          userId: userKey
        });
      }
      // Browser control (Hermes-style browser_*) is available BY DEFAULT under
      // --with-tools — not gated behind --actuators. Reads/navigation are free;
      // browser_click/type carry the draft-first confirm. Chrome launches lazily
      // on first use, so registering the tools costs nothing.
      let browserControllerToRelease: { disconnect(): Promise<void> } | undefined;
      if (options.withTools === true) {
        const actuatorMod = await import("./actuator-tools.js");
        const browserTools = actuatorMod.buildBrowserTools({
          env: process.env,
          io,
          onController: (controller) => { browserControllerToRelease = controller; },
          // browser_look reads the page visually via the same local vision the
          // screen-read/file-read paths use (lazy holder; model bound below).
          describeImage: async (input) => screenVision.current ? screenVision.current(input) : { error: "the local vision model is not available in this run", ok: false }
        });
        extraTools = extraTools ? [...extraTools, ...browserTools] : browserTools;
        // The @muse/fs read suite rides along by default: file_read (path or
        // name fragment, incl. PDF/Word/image), file_list (glob), file_grep
        // (content search) — read-risk, home-sandboxed, fail-closed on a denied
        // path. The home-wide sandbox supersedes the old 3-folder file_read.
        const { createFsReadTools, createFsWriteTools, fileReadCharBudget, pathSafetyOptionsFromEnv } = await import("@muse/fs");
        const { createWebDownloadTool } = await import("@muse/domain-tools");
        const { DEFAULT_OLLAMA_NUM_CTX, isWebEgressAllowed } = await import("@muse/model");
        // Sandbox overrides: MUSE_FS_ROOTS narrows the allow-root (default home),
        // MUSE_FS_DENY adds deny prefixes on top of the credential defaults.
        const fsSandbox = pathSafetyOptionsFromEnv(process.env);
        // Opt-in name-fragment search roots. OFF by default: recursively walking
        // the user's Downloads/Desktop/Documents (macOS TCC-protected) on a
        // name-only file_read would fire a system permission prompt unprompted.
        // Set MUSE_FS_DOC_ROOTS to a comma/colon-separated folder list (e.g.
        // "~/Downloads,~/Documents") to re-enable it. Explicit-path reads never
        // need this — they go straight through the home sandbox.
        const fsHome = (await import("node:os")).homedir();
        const fsDocRootsRaw = process.env.MUSE_FS_DOC_ROOTS?.trim();
        const fsDocRoots = fsDocRootsRaw
          ? fsDocRootsRaw
              .split(/[,:]/)
              .map((p) => p.trim())
              .filter((p) => p.length > 0)
              .map((p) => (p === "~" ? fsHome : p.startsWith("~/") ? `${fsHome}/${p.slice(2)}` : p))
          : [];
        // web_download saves a file from a public URL into ~/Downloads — the
        // write-side companion to file_read (SSRF-guarded, size-capped,
        // basename-only). file_read can then read/summarize what was saved.
        // Read-before-edit grounding: file_edit / file_multi_edit fail-close on a
        // file this run never read (Muse mutates only what it has actually seen).
        const fsReadPaths = new Set<string>();
        // A FULL file_read fills this too; a partial file_grep does NOT — so a
        // whole-file overwrite (file_write) can demand a complete read, not just
        // a grep of a few lines (which would silently drop the rest).
        const fsFullReadPaths = new Set<string>();
        const fsReadTools = createFsReadTools({
          ...fsSandbox,
          ...(fsDocRoots.length > 0 ? { docRoots: fsDocRoots } : {}),
          // Cap a single file_read to fit the local model's context — the 200K
          // default exceeds a 32K-token window whole, so one max read would
          // overflow it and silently drop the prompt/history. The model pages
          // larger files via the returned nextOffset.
          maxTextChars: fileReadCharBudget(DEFAULT_OLLAMA_NUM_CTX),
          // Same context budget for a broad file_grep — 200 matches × 500 chars
          // would otherwise nearly fill the window.
          maxGrepOutputChars: fileReadCharBudget(DEFAULT_OLLAMA_NUM_CTX),
          onPathRead: (canonicalPath) => fsReadPaths.add(canonicalPath),
          onFullRead: (canonicalPath) => fsFullReadPaths.add(canonicalPath),
          // file_read reads an IMAGE file via the same local vision the screen-
          // read path uses (lazy holder — the assembly/model is bound below).
          describeImage: async (input) => screenVision.current ? screenVision.current(input) : { error: "the local vision model is not available in this run", ok: false }
        });
        // file_write / file_edit / file_multi_edit: home-sandboxed + deny-listed
        // and gated by a fail-close confirm (the exposure policy only surfaces
        // them when the prompt shows mutation intent). A wrong overwrite isn't
        // trivially reversible, so the gate denies in any non-interactive run.
        const { confirm: fsConfirm, isCancel: fsIsCancel } = await import("@clack/prompts");
        const fsWriteTools = createFsWriteTools({
          ...fsSandbox,
          wasPathRead: (canonicalPath) => fsReadPaths.has(canonicalPath),
          wasPathFullyRead: (canonicalPath) => fsFullReadPaths.has(canonicalPath),
          checkEditIntegrity: true,
          approvalGate: actuatorMod.buildFsWriteApprovalGate({
            confirmAction: (message: string) => fsConfirm({ message }).then((answer) => !fsIsCancel(answer) && answer === true),
            io,
            stagePendingApproval: actuatorMod.buildCliPendingApprovalStager({ file: resolvePendingApprovalsFile(process.env as MuseEnvironment) })
          })
        });
        // web_download reaches the public web, so the master web-egress switch
        // (airplane mode) removes it; fs tools are local and unaffected.
        const webDownloadTools = isWebEgressAllowed(process.env)
          ? [createWebDownloadTool({ fetchImpl: globalThis.fetch })]
          : [];
        extraTools = [...extraTools, ...fsReadTools, ...fsWriteTools, ...webDownloadTools];
      }
      // The agent's `muse.messaging.send` (a default loopback tool whenever a
      // messenger is configured) gets a draft-first confirm gate under --with-tools:
      // show the exact {provider, destination, text} and fire ONLY on confirm,
      // fail-closed in a non-TTY. Without this gate the send fail-closes entirely
      // Built independently of --actuators so a benign "send X" isn't
      // blocked by the actuator tool descriptions' injection-guard false-positive.
      let messagingApprovalGate: MessageApprovalGate | undefined;
      if (options.withTools === true) {
        const actuatorMod = await import("./actuator-tools.js");
        const { confirm, isCancel } = await import("@clack/prompts");
        messagingApprovalGate = actuatorMod.buildMessagingApprovalGate({
          confirmAction: (message: string) => confirm({ message }).then((answer) => !isCancel(answer) && answer === true),
          io
        });
      }
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
      // inline (it feeds `assembly.agentRuntime.run`, not the seam's generate
      // callback below). The plain chat-only path composes the SAME
      // retrieval→dedup→reorder→demoteStale→context-block→system-prompt work
      // through `runGroundedRecall`'s seam (`streamGroundedRecall`, further
      // down) so it stays byte-identical to the API/MCP callers of that
      // pipeline instead of a second hand-maintained copy.
      let systemPrompt = "";
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

      let collectedAnswer = "";
      let answerLogprobs: AskStreamResult["logprobs"];
      let toolsUsed: readonly string[] = [];
      // Populated at the end of EITHER branch below — the notes citation
      // allowlist, the full (notes + every other source) citation allowlist,
      // and the FIRST-pass-only stripped-citation list (pre-refusal-strip;
      // what the --json `strippedCitations` field and the stderr warning use).
      let allowedNotes: readonly string[] = [];
      let citationAllowed: Parameters<typeof enforceAnswerCitations>[1] = {};
      let preRefusalStrippedCitations: readonly string[] = [];
      // One run id shared across the runtime input, token-usage attribution, the
      // checkpoints, AND the run-log filename — so per-run cost works and `muse
      // trace <id>` links a run to its steps (they were unrelated ids).
      const askRunId = createRunId();
      // The agent's read-tool outputs (web fetches, knowledge_search, …) — the
      // evidence the --with-tools answer was grounded in. Fed into the output
      // grounding verdict below so a web-grounded answer isn't false-flagged
      // against the notes-only evidence set.
      let agentGroundingSources: readonly { readonly source: string; readonly text: string }[] = [];
      let decompositionSignals: DecompositionTrustSignals | undefined;
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
      if (options.withTools) {
        systemPrompt = buildFullSystemPrompt({ contextBlock, notesFraming });
        printGroundedBanner(scored, notesFraming.verdict);
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
        const adHocChunks: readonly ScoredChunk[] = scored.slice(preAdHocChunkCount);
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
