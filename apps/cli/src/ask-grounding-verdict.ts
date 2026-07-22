/**
 * Output-side grounding VERDICT for `muse ask`, lifted out of the commands-ask
 * god-file: the recall edge's drift gate under BOTH the chat-only AND the
 * --with-tools path (one gate under EVERY surface). Even after invented citations
 * are stripped, it warns when the answer's claims drift beyond the grounded
 * passages — the fabrication signal the citation gate alone can't see. Bundles the
 * evidence assembly (notes + every non-note source the model was shown), the
 * verdict itself (MaTTS re-verify on the ambiguous band), best-of-N resample,
 * grounded≠true source-check cues (untrusted-only / citation precision+recall),
 * --repair constructive rewrite, per-claim ISSUP refinement, --why explanation,
 * and the "shows its work" source receipts. Returns the (possibly best-of-replaced)
 * answer plus the verdict label, source-check signals, and retrieval trace.
 */

import { buildAttributedRepairPrompt, buildGroundingReverifyPrompt, citedSourcesIn, enforceAnswerCitations, explainGroundingVerdict, parseGroundingReverifyJson, repairToEvidence, REPAIR_SYSTEM_PROMPT, resolveRecallConfidentAt, REVERIFY_RESPONSE_FORMAT, REVERIFY_SYSTEM_PROMPT, screenClaimsBySemanticSupport, segmentClaims, selectBestGroundedDraft, verifyGrounding, verifyGroundingPerClaim, verifyGroundingWithReverify, type GroundingReverify } from "@muse/agent-core";
import { augmentNoteEvidenceWithCited, answerIsRefusal, buildDiskContents, citationPrecisionNotice, citationRecallNotice, collectCitedNoteAges, composeChatSystemContent, contactGroundingEvidence, drawBestGroundedRedraft, formatNonNoteReceipts, formatSourceReceipts, formatStalenessWarning, groundingVerdictNotice, relativizeNoteSource, renderMemoryFact, shouldSuggestRepair, sourceCheckSignals, stripEchoedCiteAs, untrustedBrowsingMatch, untrustedEpisodeMatch, untrustedFeedMatch, untrustedOnlyGroundingNotice, type FileEntry, type ScoredChunk, type SourceCheckSignals } from "@muse/recall";
import { allUserMemoryFacts } from "@muse/recall";
import { resolveAnswerTemperature, type MuseEnvironment } from "@muse/autoconfigure";
import { existsSync } from "node:fs";
import type { ModelProvider } from "@muse/model";

import type { ActivityGrounding } from "./ask-activity-grounding.js";
import type { FlowsGrounding } from "./ask-flows-grounding.js";
import type { PersonalStoreGrounding } from "./ask-personal-store-grounding.js";
import type { SessionFeedReflectionGrounding } from "./ask-session-grounding.js";
import { filterLiveNoteIndexFiles } from "./commands-recall.js";
import { embed } from "./embed.js";
import { parseBoundedInt } from "./parse-bounded-int.js";
import { summarizeRetrieval, type RetrievalTraceEntry } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

export interface GroundingVerdictResult {
  readonly collectedAnswer: string;
  readonly groundedVerdictLabel: "grounded" | "ungrounded" | null;
  readonly sourceCheck: SourceCheckSignals | undefined;
  readonly askRetrieval: readonly RetrievalTraceEntry[] | undefined;
}

export async function runGroundingVerdict(params: {
  readonly provider: ModelProvider | undefined;
  readonly model: string;
  readonly embedModel: string;
  readonly query: string;
  readonly collectedAnswer: string;
  readonly refusalAnswer: boolean;
  readonly scored: readonly ScoredChunk[];
  readonly notesDir: string;
  readonly untrustedNoteSources: ReadonlySet<string>;
  readonly index: { readonly files: readonly FileEntry[] } | undefined;
  readonly imageAttachments: ReadonlyArray<unknown>;
  readonly adHocVerifyTargets: Map<string, string | null>;
  readonly systemPrompt: string;
  readonly playbookSection: string | undefined;
  readonly citationAllowed: Parameters<typeof enforceAnswerCitations>[1];
  readonly allowedNotes: readonly string[];
  readonly agentGroundingSources: readonly { readonly source: string; readonly text: string }[];
  readonly allMemoryFacts: ReturnType<typeof allUserMemoryFacts>;
  readonly matchedContacts: PersonalStoreGrounding["matchedContacts"];
  readonly openTasks: PersonalStoreGrounding["openTasks"];
  readonly upcomingEvents: PersonalStoreGrounding["upcomingEvents"];
  readonly pendingReminders: PersonalStoreGrounding["pendingReminders"];
  readonly episodeHits: SessionFeedReflectionGrounding["episodeHits"];
  readonly untrustedEpisodeIds: SessionFeedReflectionGrounding["untrustedEpisodeIds"];
  readonly feedHeadlines: SessionFeedReflectionGrounding["feedHeadlines"];
  readonly browsingHits: SessionFeedReflectionGrounding["browsingHits"];
  readonly matchedActions: ActivityGrounding["matchedActions"];
  readonly matchedCommands: ActivityGrounding["matchedCommands"];
  readonly matchedCommits: ActivityGrounding["matchedCommits"];
  readonly matchedFlows: FlowsGrounding["matchedFlows"];
  readonly options: {
    readonly withTools?: boolean;
    readonly json?: boolean;
    readonly bestOf?: string;
    readonly repair?: boolean;
    readonly verifyClaims?: boolean;
    readonly why?: boolean;
  };
  readonly io: ProgramIO;
}): Promise<GroundingVerdictResult> {
  const {
    provider, model, embedModel, query, refusalAnswer, scored, notesDir,
    untrustedNoteSources, index, imageAttachments, adHocVerifyTargets, systemPrompt,
    playbookSection, citationAllowed, allowedNotes, agentGroundingSources, allMemoryFacts,
    matchedContacts, openTasks, upcomingEvents, pendingReminders, episodeHits,
    untrustedEpisodeIds, feedHeadlines, browsingHits, matchedActions, matchedCommands, matchedCommits, matchedFlows,
    options, io
  } = params;
  let collectedAnswer = params.collectedAnswer;
  let groundedVerdictLabel: "grounded" | "ungrounded" | null = null;
  let sourceCheck: SourceCheckSignals | undefined;
  let askRetrieval: readonly RetrievalTraceEntry[] | undefined;

  {
        const reverify: GroundingReverify | undefined = provider
          ? async ({ answer, evidence, query: q }) => {
              const judged = await provider.generate({
                maxOutputTokens: 24,
      responseFormat: REVERIFY_RESPONSE_FORMAT,
                messages: [
                  { content: REVERIFY_SYSTEM_PROMPT, role: "system" },
                  { content: buildGroundingReverifyPrompt({ answer, evidence, query: q }), role: "user" }
                ],
                model,
                temperature: 0
              });
              return parseGroundingReverifyJson(judged.output ?? "");
            }
          : undefined;
        // The verdict scores the answer's coverage against retrieved evidence. A
        // fact drawn from a NON-NOTE source (a contact's email, a task title, a
        // reminder, a calendar event, a past session, a logged action, a feed
        // headline) has no support in the note chunks, so a notes-only evidence
        // set falsely flags it "not backed by your notes". Score against EVERY
        // grounded source the model was actually shown — each a high-precision
        // structured / retrieved match — so an answer drawn from the user's own
        // tasks / reminders / events / contacts verifies as grounded, not
        // unverified. Fabrication is still caught: the evidence is ONLY the real
        // retrieved sources, so a claim in none of them stays uncovered →
        // ungrounded.
        const exactMatch = (source: string, text: string): { cosine: number; score: number; source: string; text: string } =>
          ({ cosine: 1, score: 1, source, text });
        // A date-bearing answer reformats the stored ISO timestamp into prose
        // ("Saturday, June 4th, 8:00 PM"), so the evidence text must carry that
        // SAME human rendering or the coverage check false-flags the derived
        // date/time as unsupported. Render in the system locale/tz — the same
        // basis the model reasons from — and keep the ISO form too (belt-and-suspenders).
        const humanDate = (value: string | Date | undefined): string => {
          if (!value) return "";
          const d = value instanceof Date ? value : new Date(value);
          if (Number.isNaN(d.getTime())) return "";
          const human = d.toLocaleString("en-US", { day: "numeric", hour: "numeric", minute: "2-digit", month: "long", weekday: "long", year: "numeric" });
          return `${human} ${d.toISOString().slice(0, 10)}`;
        };
        // Note evidence for the verdict. Chat-only: `scored` (the top-K shown to
        // the model) IS exactly what grounded the answer. --with-tools: the agent
        // can pull a chunk via `knowledge_search` (often on a REFORMULATED query)
        // that the CLI's pre-retrieval top-K didn't include, so scoring against
        // `scored` alone would false-flag a legitimately grounded agent answer.
        // Augment with the FULL text of every note the answer actually cites
        // (each already gate-validated against the live corpus above) so a cited
        // note is always covered. This only ADDS evidence — it can prevent a
        // false "ungrounded", never cause a false "grounded": a drifted value
        // that appears in no cited note still scores uncovered → ungrounded.
        // `untrustedNoteSources` is computed once near the note-context block above
        // (ingested-note paths) and reused here to tag grounding evidence trusted:false
        // so an answer resting solely on a poisoned ingested note trips the
        // untrusted-only cue (GROUNDED≠TRUE). User-authored notes → no entry → trusted.
        const baseNoteMatches = scored.map((r) => {
          const source = relativizeNoteSource(r.file, notesDir);
          return { cosine: r.score, score: r.score, source, text: r.chunk.text, ...(untrustedNoteSources.has(source) ? { trusted: false } : {}) };
        });
        const noteMatches = options.withTools && index
          ? augmentNoteEvidenceWithCited(
              baseNoteMatches,
              citedSourcesIn(collectedAnswer),
              filterLiveNoteIndexFiles(index.files, existsSync).map((f) => ({ chunks: f.chunks, source: relativizeNoteSource(f.path, notesDir) }))
            )
          : baseNoteMatches;
        const scoredMatches = [
          ...noteMatches,
          ...matchedContacts.map((c) => exactMatch(`contact: ${c.name}`, contactGroundingEvidence(c))),
          ...matchedFlows.map((f) => exactMatch(`flow: ${f.name}`, `${f.name}${f.description ? ` ${f.description}` : ""} ${f.cronExpression} ${f.enabled ? "on" : "paused"} ${f.webhookTriggerToken ? "webhook" : "schedule"}`.trim())),
          ...openTasks.map((t) => exactMatch(`task: ${t.title}`, `${t.title}${t.notes ? ` ${t.notes}` : ""}${t.dueAt ? ` due ${t.dueAt} ${humanDate(t.dueAt)}` : ""}`)),
          ...upcomingEvents.map((e) => exactMatch(`event: ${e.title}`, `${e.title}${e.location ? ` ${e.location}` : ""} ${humanDate(e.startsAt)} ${humanDate(e.endsAt)}`.trim())),
          ...pendingReminders.map((r) => exactMatch(`reminder: ${r.text}`, `${r.text} ${humanDate(r.dueAt)}`.trim())),
          ...episodeHits.map((e) => untrustedEpisodeIds.has(e.id)
            ? untrustedEpisodeMatch(e.id, e.summary, e.score)
            : ({ cosine: e.score, score: e.score, source: `session: ${e.id}`, text: e.summary })),
          ...matchedActions.map((a) => exactMatch(`action: ${a.what}`, `${a.what} ${a.result}${a.detail ? ` ${a.detail}` : ""}`)),
          ...matchedCommands.map((cmd) => exactMatch(`command: ${cmd}`, cmd)),
          ...matchedCommits.map((c) => exactMatch(`commit: ${c.subject}`, c.subject)),
          ...allMemoryFacts.map((f) => exactMatch(`memory: ${f.key}`, renderMemoryFact(f))),
          // Feeds are third-party publisher content (RSS/Atom) — NOT the user's
          // own data — so tag them trusted:false: an answer resting SOLELY on a
          // poisonable feed headline must trip the untrusted-only source-check
          // cue (grounded≠true), exactly like a web/MCP tool result below.
          ...feedHeadlines.map((h) => untrustedFeedMatch(h.feedName, h.title, h.summary)),
          // Local browsing-history visits: the page TITLE is third-party-controlled
          // text (the site author's, not the user's), so tag trusted:false exactly
          // like a feed headline — an answer resting SOLELY on a visited page trips
          // the untrusted-only source-check cue (grounded≠true).
          ...browsingHits.map((h) => untrustedBrowsingMatch(h.host, h.title, h.url)),
          // The --with-tools agent's OWN read-tool outputs (web fetches,
          // knowledge_search, …): the evidence it was shown. Without these a
          // correctly web-grounded answer scores ~zero coverage against the
          // notes-only set above and false-flags "not backed by your notes".
          // Still fabrication-safe: only REAL tool outputs are added, so a claim
          // in none of them (notes OR tool results) stays uncovered → ungrounded.
          // trusted:false — tool output is NOT the user's own data; the
          // provenance bit feeds groundedOnUntrustedOnly (grounded≠true).
          ...agentGroundingSources.map((s) => ({ ...exactMatch(`tool: ${s.source}`, s.text), trusted: false }))
        ];
        askRetrieval = summarizeRetrieval(scoredMatches);
        // The coverage check strips citation markers before scoring, so a LIST
        // answer whose claims live only inside `[task: …]` / `[event: …]` markers
        // (the model put the titles in the citation, not the prose) would score
        // ~zero coverage and false-flag. By verdict time every surviving
        // content-citation is already gate-validated against a real source, so
        // expand them inline for the verdict ONLY — their content is grounded by
        // construction and is present in `scoredMatches`. `[from …]` note
        // provenance is left alone (it carries no claim).
        const expandContentCitations = (answer: string): string => answer.replace(
          /\[(?:task|event|reminder|contact|session|feed|browsing|command|commit|memory|action|flow):\s*([^\]]*)\]/giu,
          " $1 "
        );
        let verdictAnswer = expandContentCitations(collectedAnswer);
        // A vision query (`--image`) is grounded in the IMAGE the user supplied,
        // not in their notes — so the notes-grounding verdict is irrelevant here
        // and its "unverified" warning would be misleading. Skip it.
        let verdictNotice = imageAttachments.length > 0
          ? undefined
          : await groundingVerdictNotice(verdictAnswer, scoredMatches, query, reverify, 3);
        // Best-of-N resample (--best-of): when the first draft fails the
        // verdict, redraw fresh drafts and let the DETERMINISTIC verifier pick
        // the best grounded survivor; the full (reverify-backed) gate then
        // confirms it before it replaces the answer. No survivor ⇒ the honest
        // warning path stands untouched, so resampling can only raise the
        // answered rate, never admit a fabrication. Chat-only path — a
        // --with-tools redraw would re-execute side-effecting tools.
        const bestOfTotal = parseBoundedInt(options.bestOf, "--best-of", 1, 5, 1);
        if (verdictNotice && bestOfTotal > 1 && provider && !options.withTools && !options.json && imageAttachments.length === 0 && !refusalAnswer) {
          const survivor = await drawBestGroundedRedraft({
            attempts: bestOfTotal - 1,
            clean: (draft) => enforceAnswerCitations(stripEchoedCiteAs(draft), citationAllowed).text,
            confirm: (verdictText) => groundingVerdictNotice(verdictText, scoredMatches, query, reverify, 3),
            draw: async () => {
              const drawn = await provider.generate({
                messages: [
                  { content: composeChatSystemContent(systemPrompt, playbookSection), role: "system" },
                  { content: query, role: "user" }
                ],
                model,
                temperature: resolveAnswerTemperature(process.env as MuseEnvironment)
              });
              return drawn.output ?? "";
            },
            expand: expandContentCitations,
            isRefusal: answerIsRefusal,
            select: (drafts) => selectBestGroundedDraft(drafts, scoredMatches, query)
          });
          if (survivor !== undefined) {
            collectedAnswer = survivor;
            verdictAnswer = expandContentCitations(survivor);
            verdictNotice = undefined;
            io.stderr(`\n🎯 Best-of-${bestOfTotal.toString()}: the first draft didn't verify against your notes — this re-drawn one did:\n`);
            io.stdout(`${survivor}\n`);
          }
        }
        if (imageAttachments.length === 0) {
          groundedVerdictLabel = verdictNotice ? "ungrounded" : "grounded";
        }
        // grounded≠true: a faithful answer (no verdictNotice) can still rest only
        // on untrusted tool-fetched sources. The label stays "grounded" (it IS
        // faithful), but surface the untrusted-only provenance as a scrutiny cue.
        const untrustedNotice = !verdictNotice && imageAttachments.length === 0
          ? untrustedOnlyGroundingNotice(verdictAnswer, scoredMatches)
          : undefined;
        if (untrustedNotice && !options.json) {
          io.stderr(untrustedNotice);
        }
        // ALCE per-citation support: a cited source that resolves but doesn't
        // support its sentence (right source, wrong claim) the whole-answer
        // verdict can miss. Only on a grounded answer (else the verdict warns).
        // Both ALCE cues read the UNexpanded answer — expandContentCitations
        // rewrites `[memory: x]` to bare content for coverage scoring, which
        // would erase the very citations these cues look for (observed false
        // "carries no citation" on a visibly-cited memory-fact answer).
        const citationNotice = !verdictNotice && imageAttachments.length === 0
          ? citationPrecisionNotice(collectedAnswer, scoredMatches)
          : undefined;
        if (citationNotice && !options.json) {
          io.stderr(citationNotice);
        }
        // ALCE citation RECALL: a groundable claim handed over with no [from …]
        // attribution. Complement to the precision cue; grounded answers only.
        const recallNotice = !verdictNotice && imageAttachments.length === 0
          ? citationRecallNotice(collectedAnswer, scoredMatches)
          : undefined;
        if (recallNotice && !options.json) {
          io.stderr(recallNotice);
        }
        // Machine twin of the three cues above: a `--json`/run-log consumer can't
        // read the human stderr cue, so without this a grounded-but-untrusted (or
        // mis-/un-cited) answer reaches a downstream agent as a clean
        // `groundedVerdict:"grounded"` — a GROUNDED≠TRUE machine-surface leak (the
        // same one V1 closed for fan-out signals). Same gate + predicates as the
        // stderr cues, so the surfaces can't drift.
        sourceCheck = !verdictNotice && imageAttachments.length === 0
          ? sourceCheckSignals(verdictAnswer, scoredMatches)
          : undefined;
        if (verdictNotice && !options.json) {
          io.stderr(verdictNotice);
          // Constructive grounding (RARR, arXiv:2210.08726): rather than only
          // warning, attempt ONE rewrite constrained to the retrieved evidence
          // and show it ONLY if it re-verifies grounded through the SAME gate
          // (so a wrong value can't survive — the claim-level check applies to
          // the fix too). Fail-closed: no grounded rewrite ⇒ the refusal stands.
          if (options.repair && provider && reverify) {
            const repair = await repairToEvidence(collectedAnswer, scoredMatches, query, {
              gate: (candidate) => enforceAnswerCitations(candidate, { notes: allowedNotes }).text,
              isRefusal: answerIsRefusal,
              rewrite: async ({ answer: draft, evidence, query: q }) => {
                const rewritten = await provider.generate({
                  maxOutputTokens: 400,
                  messages: [
                    { content: REPAIR_SYSTEM_PROMPT, role: "system" },
                    { content: buildAttributedRepairPrompt({ answer: draft, evidence, query: q }), role: "user" }
                  ],
                  model,
                  temperature: 0
                });
                return rewritten.output ?? "";
              },
              verify: (candidate, candidateMatches, q) => verifyGroundingWithReverify(candidate, candidateMatches, q, reverify, { confidentAt: resolveRecallConfidentAt() })
            });
            if (repair.repaired) io.stderr(`\n🔧 Corrected from your notes:\n${repair.repaired}\n`);
          } else if (shouldSuggestRepair({ evidenceCount: scoredMatches.length, json: Boolean(options.json), repairRequested: Boolean(options.repair), verdictFired: true })) {
            io.stderr("(Re-run with --repair and I'll rewrite this using only your notes — shown only if it then checks out.)\n");
          }
        } else if (reverify && !options.json && !answerIsRefusal(collectedAnswer)) {
          // Per-claim ISSUP refinement (MiniCheck, arXiv:2404.10774): DEFAULT-ON on
          // the grounded-PASS branch. A single fabricated sentence can ride through
          // whole-answer scoring; the semantic cosine pre-filter (screenClaimsBySemanticSupport)
          // cheaply marks only SUSPECT claims for the LLM judge — non-suspect claims
          // skip the model call entirely. Runs only after the whole-answer gate PASSED
          // (no verdictNotice) so it can only TIGHTEN, never manufacture a refusal.
          // FAIL-OPEN at both layers: screen error → suspect:false; judge error → keep.
          // --verify-claims forces all-claims judging (bypasses the cheap screen).
          const claimsToCheck = segmentClaims(verdictAnswer);
          if (claimsToCheck.length > 1) {
            const evidenceTexts = scoredMatches.map((m) => m.text);
            let suspectClaims: ReadonlySet<string> | undefined;
            if (!options.verifyClaims) {
              const screens = await screenClaimsBySemanticSupport(
                claimsToCheck,
                evidenceTexts,
                (t) => embed(t, embedModel)
              );
              suspectClaims = new Set(screens.filter((s) => s.suspect).map((s) => s.claim));
            }
            const refinement = await verifyGroundingPerClaim(verdictAnswer, scoredMatches, query, reverify, { suspectClaims, reverifySamples: 3 });
            if (refinement.dropped > 0) {
              io.stderr(`\n🔬 Per-claim check — I can only ground part of that:\n${refinement.answer}\n`);
            }
          }
        }

        // `--why`: the "shows its work" edge applied to the REFUSAL itself. When
        // the answer isn't grounded, name the deterministic rubric criterion that
        // fell short + the measured value vs threshold, so an opaque "I'm not
        // sure" becomes actionable (rephrase / reindex / add a note). No extra
        // model call (the rubric is deterministic); silent on a grounded answer;
        // runs even on a refusal — which the fabrication warning above skips —
        // since explaining WHY it refused is exactly the point.
        if (options.why && !options.json) {
          const topCosine = scoredMatches.length > 0
            ? Math.max(...scoredMatches.map((m) => m.cosine ?? m.score))
            : undefined;
          const whyLines = explainGroundingVerdict(verifyGrounding(verdictAnswer, scoredMatches, query, { confidentAt: resolveRecallConfidentAt() }), { topCosine });
          if (whyLines.length > 0) {
            const head = answerIsRefusal(collectedAnswer) ? "Why I can't answer from your notes" : "Why this answer is flagged";
            io.stderr(`\n🔎 ${head}:\n${whyLines.map((l) => `  • ${l}`).join("\n")}\n`);
          }
        }

        // "Shows its work" made FOLLOWABLE *and FELT* (S1 citation-as-voice):
        // each cited note rendered as a memory — "from your note of <date> —
        // '<verbatim snippet>'" + the openable path. Rendered ONLY when the
        // answer PASSED the grounding verdict — a receipt on an ungrounded answer
        // would vouch for a fabrication (the edge must not "show its work" for
        // work that failed its own check); the warning above stands alone there.
        // A refusal asserts no claim so it never reaches here with citations.
        if (!verdictNotice && !options.json) {
          // L4 disk-verify: re-read each cited note NOW so a snippet the file no
          // longer contains (note edited/deleted after indexing) is hidden instead
          // of quoted as a fake citation. Ad-hoc sources skipped (own provenance).
          const diskContents = await buildDiskContents(
            collectedAnswer,
            scored.map((r) => ({ file: r.file, text: r.chunk.text })),
            notesDir,
            adHocVerifyTargets
          );
          const receipts = formatSourceReceipts(
            collectedAnswer,
            notesDir,
            scored.map((r) => ({ file: r.file, text: r.chunk.text })),
            query,
            adHocVerifyTargets,
            diskContents
          );
          if (receipts) io.stderr(receipts);
          // Staleness heads-up: a fact drawn from a long-untouched note may be
          // out of date — show the source's age so the user can judge it.
          if (!options.json) {
            const staleness = formatStalenessWarning(
              await collectCitedNoteAges(collectedAnswer, scored.map((r) => ({ file: r.file, text: r.chunk.text })), notesDir, new Date(), adHocVerifyTargets),
              180 * 86_400_000
            );
            if (staleness) {
              io.stderr(staleness);
            }
          }
          const moreReceipts = formatNonNoteReceipts(collectedAnswer, {
            actions: matchedActions.map((a) => a.what),
            commands: matchedCommands,
            commits: matchedCommits.map((c) => c.subject),
            contacts: matchedContacts.map((c) => c.name),
            events: upcomingEvents.map((e) => e.title),
            feeds: feedHeadlines.map((h) => h.feedName),
            flows: matchedFlows.map((f) => f.name),
            browsing: browsingHits.map((h) => h.host),
            memories: allMemoryFacts.map(renderMemoryFact),
            reminders: pendingReminders.map((r) => r.text),
            sessions: episodeHits.map((e) => e.summary),
            tasks: openTasks.map((t) => t.title)
          });
          if (moreReceipts) io.stderr(moreReceipts);
        }
      }

  return { askRetrieval, collectedAnswer, groundedVerdictLabel, sourceCheck };
}
