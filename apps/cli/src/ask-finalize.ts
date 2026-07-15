/**
 * Post-answer finalization + rendering for `muse ask`, lifted out of the
 * commands-ask god-file. Runs AFTER the grounding verdict on the terminal path
 * (no early returns): the deterministic user-facing cues (EVPI clarification,
 * set-level sufficiency advisory, warm-refusal close, honesty backstop, applied-
 * preference beat, probation-strategy nudge), the outcome-labeled run-log trace
 * (misgrounding + source-conflict downgrades), the weakness-ledger write +
 * implicit playbook reinforcement + ask-time weakness nudge, and finally the
 * --json object or the plain-text + --connect footer. Emit/compute only — it
 * mutates no caller state and returns nothing.
 */

import { answerPromisesAction, assertiveUnsupportedFraction, decideRecallClarification, implicitSuccessReinforceDelta, isUnbackedActionClaim, lexicalOverlap, lexicalTokens, reportSentenceGroundedness, requestsToolAction, stripCitationMarkers, summarizeTokenConfidence, worstUnsupportedSentence } from "@muse/agent-core";
import { answerIsRefusal, askOutcomeLabel, askWeaknessAxis, buildAskConnections, contestedOutcome, createStageTimer, formatGraphLinksSection, groundingConflictCue, misgroundedOutcome, recordAskWeakness, recordAskWeaknessResolved, relativizeNoteSource, shouldWarmClose, sufficiencyAdvisory, type AskWeaknessAxis } from "@muse/recall";
import { resolveNotesDir, type MuseEnvironment } from "@muse/autoconfigure";
import { parseBooleanFromEnv } from "@muse/shared";

import { isQuiet } from "./cli-context.js";
import { crossLingualUnsupportedFraction } from "./ask-cross-lingual.js";
import { selectGraphConnections } from "./ask-corpus-helpers.js";
import { loadNoteLinkGraph } from "./commands-notes-rag.js";
import { formatConnectionsSection } from "./commands-today.js";
import { embed } from "./embed.js";
import type { PersonalStoreGrounding } from "./ask-personal-store-grounding.js";
import type { SessionFeedReflectionGrounding } from "./ask-session-grounding.js";
import type { AskStreamResult, DecompositionTrustSignals } from "./ask-result-output.js";
import { buildAskRunLog, writeRunLog, type RetrievalTraceEntry } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";
import type { SourceCheckSignals, IndexChunk } from "@muse/recall";

function environment(): MuseEnvironment {
  return process.env;
}

type ScoredChunk = { chunk: IndexChunk; file: string; score: number };

/** S2 warm honesty (B2): the deterministic, on-brand close on an honest refusal. */
const WARM_REFUSAL_CLOSE =
  "(I'd rather tell you that than guess — add a note on this and I'll have it next time.)";

async function recordAskWeaknessLive(query: string, axis: AskWeaknessAxis | null, hint?: string): Promise<void> {
  if (axis === null) {
    return;
  }
  try {
    const { recordWeakness } = await import("@muse/stores");
    const { resolveWeaknessesFile } = await import("@muse/autoconfigure");
    await recordAskWeakness(query, axis, {
      recordWeakness,
      weaknessesFile: resolveWeaknessesFile(environment())
    }, hint);
  } catch {
    // lazy-import / path resolution failure is non-fatal
  }
}

async function recordAskWeaknessResolvedLive(query: string): Promise<void> {
  try {
    const { recordWeaknessResolved } = await import("@muse/stores");
    const { resolveWeaknessesFile } = await import("@muse/autoconfigure");
    await recordAskWeaknessResolved(query, {
      recordWeaknessResolved,
      weaknessesFile: resolveWeaknessesFile(environment())
    });
  } catch {
    // lazy-import / path resolution failure is non-fatal
  }
}

export async function finalizeAndRenderAsk(params: {
  readonly options: { readonly json?: boolean; readonly withTools?: boolean; readonly connect?: boolean };
  readonly io: ProgramIO;
  readonly query: string;
  readonly model: string;
  readonly embedModel: string;
  readonly collectedAnswer: string;
  readonly refusalAnswer: boolean;
  readonly groundedVerdictLabel: "grounded" | "ungrounded" | null;
  readonly scored: readonly ScoredChunk[];
  readonly notesDir: string;
  readonly splitClauses: readonly string[];
  readonly subqueryEmbeddings: ReadonlyArray<readonly number[]>;
  readonly noteFileCount: number;
  readonly appliedStrategy: string | undefined;
  readonly appliedStrategyId: string | undefined;
  readonly probationSuggestion: { readonly text: string; readonly id: string } | undefined;
  readonly askStages: ReturnType<typeof createStageTimer>;
  readonly askRunId: string;
  readonly answerLogprobs: AskStreamResult["logprobs"];
  readonly decompositionSignals: DecompositionTrustSignals | undefined;
  readonly sourceCheck: SourceCheckSignals | undefined;
  readonly askRetrieval: readonly RetrievalTraceEntry[] | undefined;
  readonly toolsUsed: readonly string[];
  readonly citationGate: { readonly stripped: readonly string[] };
  readonly openTasks: PersonalStoreGrounding["openTasks"];
  readonly upcomingEvents: PersonalStoreGrounding["upcomingEvents"];
  readonly pendingReminders: PersonalStoreGrounding["pendingReminders"];
  readonly episodeHits: SessionFeedReflectionGrounding["episodeHits"];
  readonly matchedMemories: Parameters<typeof groundingConflictCue>[2];
}): Promise<void> {
  const {
    options, io, query, model, embedModel, collectedAnswer, refusalAnswer, groundedVerdictLabel,
    scored, notesDir, splitClauses, subqueryEmbeddings, noteFileCount, appliedStrategy,
    appliedStrategyId, probationSuggestion, askStages, askRunId, answerLogprobs,
    decompositionSignals, sourceCheck, askRetrieval, toolsUsed, citationGate, openTasks,
    upcomingEvents, pendingReminders, episodeHits, matchedMemories
  } = params;

      // EVPI / expected-information-gain (Lindley 1956; Howard 1966): when the
      // notes hold several EQUALLY-strong but DISTINCT matches, the residual
      // uncertainty is over WHICH the user meant — a single clarifying question
      // has higher expected value than silently answering the top one (which may
      // be the wrong reading). Surface the divergent sources so the user can
      // disambiguate; the best-effort answer above still stands. Deterministic
      // (no model call), suppressed on a refusal (already says "I'm not sure").
      if (!options.json && !answerIsRefusal(collectedAnswer)) {
        const clarification = decideRecallClarification(
          scored.map((r) => ({ cosine: r.score, score: r.score, source: relativizeNoteSource(r.file, notesDir), text: r.chunk.text }))
        );
        if (clarification.clarify) {
          const offered = clarification.sources.map((s) => `[${s}]`).join(", ");
          io.stderr(`\n⚖️ Your notes gave a few equally-strong but different matches — did you mean ${offered}? Re-ask naming one for a single grounded answer.\n`);
        }
      }

      // Set-level sufficiency advisory (arXiv:2411.06037): when a multi-part
      // query has sub-queries with no covering passage, name the uncovered parts
      // so the user knows which half is unverified. ADVISORY-ONLY — never blocks
      // the answer or changes the citation gate. Fail-open (empty vecs → no-op).
      const sufficiencyLine = sufficiencyAdvisory({
        answer: collectedAnswer,
        evidenceVecs: scored.map((r) => r.chunk.embedding),
        json: Boolean(options.json),
        subQueries: splitClauses,
        subQueryVecs: subqueryEmbeddings
      });
      if (sufficiencyLine) {
        io.stderr(`\n⚠️ ${sufficiencyLine}\n`);
      }

      // S2 warm honesty (B2): when Muse honestly refuses AND the user has
      // notes, close with one on-brand line so the refusal feels cared-for,
      // not blocked. Empty corpus gets the on-ramp hint instead; a real cited
      // answer gets nothing. Deterministic line, no note pointer (so it can't
      // reintroduce the spurious-citation-on-a-refusal confusion that was fixed).
      if (!options.json && shouldWarmClose(collectedAnswer, noteFileCount)) {
        io.stderr(`\n${WARM_REFUSAL_CLOSE}\n`);
      }

      // Honesty backstop: the model claimed an action ("I'll remind you…") on the
      // chat-only path, where nothing was actually done — correct it. Catches the
      // MIXED "what's my rent AND remind me to pay it tomorrow" the imperative-
      // anchored classifyActionRequest misses. (--with-tools really acts, so the
      // claim is TRUE there — never correct it on that path.)
      if (!options.json && !options.withTools && answerPromisesAction(collectedAnswer)) {
        io.stderr("\n(Heads up: I can't actually set reminders, tasks, or events on this path — re-run with `--with-tools` to do that.)\n");
      }

      // S6 "I learned this about you" (B2): when a learned preference was both
      // INJECTED and genuinely RELEVANT to this question (token overlap — a
      // recency-floor pick never triggers the claim), surface a one-line beat so
      // the user FEELS Muse growing with them. Deterministic (no second model
      // call), grounded in the user's OWN taught strategy, suppressed on a
      // refusal (which applied nothing), and wired to the `undo` reversal.
      if (!options.json && !isQuiet() && appliedStrategy && !answerIsRefusal(collectedAnswer)
        && lexicalOverlap(lexicalTokens(query), appliedStrategy) > 0) {
        io.stderr(`\n💡 Applied a preference you taught me: "${appliedStrategy}". (Not right? \`muse playbook undo\`.)\n`);
      }

      // Felt self-learning: when a topic the user CORRECTED resurfaces,
      // surface the strategy the daemon distilled from that correction — recorded
      // unattended but still on PROBATION (not applied) — so the user is reminded
      // at the relevant moment and can choose to apply it. Surface-only: it never
      // entered the model's reasoning (the held graduation stays user-gated); one
      // command applies it. Suppressed on a refusal (no claim to refine) and when a
      // graduated preference already applied (don't double up on one answer).
      if (!options.json && !isQuiet() && probationSuggestion && !appliedStrategy && !answerIsRefusal(collectedAnswer)) {
        io.stderr(`\n💡 You've corrected me on this before — I noted: "${probationSuggestion.text}". Apply it going forward with \`muse playbook reward ${probationSuggestion.id.slice(0, 8)}\`.\n`);
      }

      // Outcome-labeled trace — parity with the remote path: writeRunLog lifts
      // `grounded`/`success` to the top level, so error-analysis can grep real
      // labels off cli.local runs instead of an unlabeled corpus.
      askStages.mark("verdictMs");
      if (parseBooleanFromEnv(process.env.MUSE_TIMINGS, false) && !options.json) {
        const t = askStages.timings();
        io.stderr(`(timings: ${Object.entries(t).map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}s`).join(" · ")})\n`);
      }
      const baseOutcome = askOutcomeLabel({ refusal: refusalAnswer, verdict: groundedVerdictLabel });
      // Evidence the answer should be backed by — the same recall / task / calendar
      // / reminder surfaces the grounding gate drew from. Reused for the
      // misgrounding probe and the weakness-ledger hint.
      const askEvidenceTexts = [
        ...scored.map((r) => r.chunk.text),
        ...openTasks.map((t) => t.title),
        ...upcomingEvents.map((e) => e.title),
        ...pendingReminders.map((r) => r.text)
      ];
      // Misgrounding probe: a "grounded" verdict can still hide a confident
      // misgrounding — the gate matched the claim to a real source, but the
      // per-sentence diagnostic shows most of the answer isn't actually backed
      // (GROUNDED != TRUE). Downgrade the TRACE label to "misgrounded" so the
      // failure becomes error-analysis fuel instead of a hidden success; the
      // user-facing answer and the gate verdict are unchanged. Skipped with no
      // evidence to check against (can't claim misgrounding without a source).
      // Strip Muse's own `[from <source>]` citation markers before the per-sentence
      // probe — they are attribution metadata, not claims, and the marker's internal
      // "." would split into a junk sentence the probe scores unsupported.
      const askAnswerForProbe = stripCitationMarkers(collectedAnswer);
      const askGroundedReport =
        baseOutcome === "grounded" && askEvidenceTexts.length > 0
          ? reportSentenceGroundedness(askAnswerForProbe, askEvidenceTexts)
          : undefined;
      // Cross-lingual faithfulness: a KO answer scores lexical-0 against an EN note,
      // so the lexical fraction can't tell a true cross-lingual grounding from a
      // fabrication. Re-judge each lexically-unsupported sentence by semantic cosine;
      // fail-soft to the lexical fraction if the embedder is unavailable.
      let askUnsupportedFraction = 0;
      if (askGroundedReport) {
        try {
          askUnsupportedFraction = await crossLingualUnsupportedFraction({
            report: askGroundedReport,
            evidence: askEvidenceTexts,
            embed: (t) => embed(t, embedModel)
          });
        } catch {
          askUnsupportedFraction = assertiveUnsupportedFraction(askGroundedReport);
        }
      }
      // Source-conflict (contested): if the answer's OWN grounding sources disagree
      // on a field (notes / episodes / remembered facts), a "grounded" verdict rests
      // on a disputed fact — the cited source may be the wrong half (GROUNDED != TRUE).
      // Downgrade the trace to "contested". Computed ONCE here and reused for the
      // user-facing cue below.
      const askSourceConflictCue = groundingConflictCue(
        scored.map((r) => ({ file: r.file, text: r.chunk.text })),
        episodeHits.map((e) => ({ id: e.id, summary: e.summary })),
        matchedMemories
      );
      const askMisgroundedOutcome = askGroundedReport
        ? misgroundedOutcome({ outcome: baseOutcome, unsupportedFraction: askUnsupportedFraction })
        : baseOutcome;
      const askOutcome = contestedOutcome({ outcome: askMisgroundedOutcome, hasSourceConflict: Boolean(askSourceConflictCue) });
      await writeRunLog(io.workspaceDir ?? process.cwd(), buildAskRunLog({
        query,
        model,
        runId: askRunId,
        timings: askStages.timings(),
        ...(answerLogprobs ? { confidence: summarizeTokenConfidence(answerLogprobs) ?? null } : {}),
        grounded: askOutcome,
        response: collectedAnswer,
        success: true,
        toolsUsed,
        ...(decompositionSignals ? { decomposition: decompositionSignals } : {}),
        ...(sourceCheck ? { sourceCheck } : {}),
        ...(askRetrieval && askRetrieval.length > 0 ? { retrieval: askRetrieval } : {})
      }));
      // Whetstone fuel: an ASK failure becomes a weakness-ledger entry so doctor
      // / error-analysis can mine real-usage gaps — previously only chat-repl fed
      // the ledger. An UNBACKED-ACTION (the answer claimed a tool action the user
      // asked for, but no actuator ran — a false promise) takes precedence over a
      // grounding miss, mirroring chat-repl.
      const askIsActionRequest = requestsToolAction(query);
      const askUnbackedAction = isUnbackedActionClaim({ query, answer: collectedAnswer, toolNames: toolsUsed });
      const askAxis = askWeaknessAxis(askOutcome, { claimedUnbackedAction: askUnbackedAction, isActionRequest: askIsActionRequest });
      let askHint: string | undefined;
      if (askAxis === "grounding-gap") {
        askHint = worstUnsupportedSentence(reportSentenceGroundedness(askAnswerForProbe, askEvidenceTexts));
      } else if (askAxis === "misgrounding") {
        askHint = askGroundedReport ? worstUnsupportedSentence(askGroundedReport) : undefined;
      }
      await recordAskWeaknessLive(query, askAxis, askHint);
      if (askOutcome === "grounded" && !askIsActionRequest) {
        await recordAskWeaknessResolvedLive(query);
        // Positive half of the reinforcement loop: a strategy that was injected AND
        // led to an answer the EXTERNAL grounding gate verified earns a gentle reward
        // (≪ the explicit ±1 of a correction/approval), so what quietly works resists
        // disuse-decay. Probation strategies are never injected → never reach here, so
        // the self-confirmation guard holds. Best-effort + fail-soft.
        // A source-check caveat (untrusted-only sources / unsupported / uncited
        // citation — `sourceCheck` is set only then) marks a GROUNDED≠TRUE-weak
        // success that must NOT reinforce, so a missed misgrounding can't corrupt the bank.
        const reinforceDelta = implicitSuccessReinforceDelta(askOutcome, { hasSourceCheckCaveat: Boolean(sourceCheck) });
        if (appliedStrategyId && reinforceDelta > 0) {
          try {
            const { adjustPlaybookReward } = await import("@muse/stores");
            const { resolvePlaybookFile } = await import("@muse/autoconfigure");
            await adjustPlaybookReward(resolvePlaybookFile(environment()), appliedStrategyId, reinforceDelta, Date.now());
          } catch { /* reinforcement is best-effort — a reward write must never break the answer */ }
        }
      }
      // Runtime learn→apply: if THIS ask failed on a topic that is now a RECURRING
      // user-remediable weakness, surface the remediation AT the moment of repeated
      // failure (not just the daily recap) — a deterministic user-facing nudge.
      if (!options.json && askAxis !== null) {
        try {
          const { askTimeWeaknessNudge, readWeaknesses, renderAskTimeNudge, topicKeyFromMessage } = await import("@muse/stores");
          const { resolveWeaknessesFile } = await import("@muse/autoconfigure");
          const weaknessEntries = await readWeaknesses(resolveWeaknessesFile(environment()));
          const nudge = askTimeWeaknessNudge(weaknessEntries, topicKeyFromMessage(query), { nowMs: Date.now() });
          if (nudge) {
            io.stderr(`💡 ${renderAskTimeNudge(nudge, /[가-힣]/u.test(query))}\n`);
          }
        } catch { /* ledger unavailable — no nudge */ }
      }

      if (options.json) {
        // Emit a single JSON object on stdout — consumers can pipe
        // through `jq` to extract the answer, grounded sources, or
        // both. The grounded banner on stderr already announced what
        // was injected; the JSON repeats it in structured form so
        // downstream scripts don't have to parse the banner.
        const payload = {
          query,
          model,
          answer: collectedAnswer,
          // The gate's verdict, so a JSON consumer can render trust honestly:
          // "grounded" | "ungrounded" | "abstain" | null (verdict didn't run).
          groundedVerdict: askOutcome,
          // Fan-out trust signals (decomposed runs only) so a machine consumer learns the
          // sub-answers contradicted / a sub-result was dropped / the list was capped —
          // the stderr banner the human gets isn't on the --json surface.
          ...(decompositionSignals ? { decomposition: decompositionSignals } : {}),
          // Source-check signals on a grounded answer (grounded≠true): rests only on
          // untrusted sources / a citation is unsupported / a claim is uncited. The
          // human got the stderr cue; the machine surface gets it structured here.
          ...(sourceCheck ? { sourceCheck } : {}),
          ...(citationGate.stripped.length > 0 ? { strippedCitations: citationGate.stripped } : {}),
          ...(options.withTools ? { toolsUsed } : {}),
          grounded: {
            noteChunks: scored.map((r) => ({ file: r.file, score: r.score, text: r.chunk.text })),
            openTasks: openTasks.map((t) => ({
              id: t.id,
              title: t.title,
              ...(t.dueAt ? { dueAt: t.dueAt } : {}),
              ...(t.urgent ? { urgent: true } : {})
            })),
            upcomingEvents: upcomingEvents.map((e) => ({
              id: e.id,
              providerId: e.providerId,
              title: e.title,
              startsAt: e.startsAt.toISOString(),
              endsAt: e.endsAt.toISOString(),
              allDay: e.allDay,
              ...(e.location ? { location: e.location } : {})
            })),
            pendingReminders: pendingReminders.map((r) => ({
              id: r.id,
              text: r.text,
              dueAt: r.dueAt
            }))
          }
        };
        io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        io.stdout("\n");
        // grounded≠true: if two of the sources backing this answer DISAGREE on a
        // field, surface it — the receipt would otherwise vouch for whichever one
        // got cited. Independent of --connect (a safety cue, not the opt-in footer).
        // Reuse the cue already computed for the contested-outcome downgrade above.
        if (askSourceConflictCue) io.stderr(`${askSourceConflictCue}\n`);
        // SB-3: a readable second-brain provenance footer the user can
        // scan — reuses the grounding already ranked this turn (no extra
        // search), only the strongest hits, shared formatter with `today`.
        if (options.connect) {
          const section = formatConnectionsSection(buildAskConnections({
            episodes: episodeHits,
            notes: scored.map((r) => ({ file: r.file, score: r.score, text: r.chunk.text }))
          }));
          if (section.length > 0) {
            io.stdout(section);
          }
          // Explicit [[wiki-link]] neighbours of the grounded notes — the user-
          // authored connections embeddings miss. Best-effort: a missing/unreadable
          // notes dir or ad-hoc-only grounding just yields no footer.
          try {
            const groundedNoteFiles = [...new Set(scored.map((r) => r.file))];
            const graph = await loadNoteLinkGraph(resolveNotesDir(environment()));
            const graphSection = formatGraphLinksSection(selectGraphConnections(graph, groundedNoteFiles));
            if (graphSection.length > 0) {
              io.stdout(graphSection);
            }
          } catch {
            // no notes dir / unreadable graph — skip the link footer silently
          }
        }
      }
}
