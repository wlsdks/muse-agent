/**
 * Council deliberation — several Muses reason about ONE question and synthesise
 * an answer from their exchanged REASONING (the `council-utterance` know-how
 * kind), never their data. Two bounded, local model steps:
 *
 *   - `produceCouncilReasoning` — a participant's take on the question. Bounded:
 *     it returns ONLY a short reasoning string (no tools, no corpus dump), and
 *     the text is PII-redacted before it leaves (it crosses the swarm). This is
 *     the one specific, opt-in computation a council request may trigger.
 *   - `synthesizeCouncilAnswer` — the initiator folds the members' reasoning
 *     into a final answer, GROUNDED in what they said: the answer cites which
 *     members it drew from, and `parseCouncilAnswer` deterministically drops any
 *     contributor id the council didn't actually include. Same honesty rule as
 *     cited recall + reflection — Council can't invent a member or a claim.
 *
 * Pure (`buildCouncilPrompt`, `parseCouncilAnswer`) + thin model-driven wrappers,
 * mirroring `reflection-synthesis`.
 */

import type { ModelMessage, ModelProvider, ModelRequest } from "@muse/model";
import { composeIdentityPrompt } from "@muse/prompts";
import { redactSecretsInText } from "@muse/shared";

import {
  type CouncilAnswer,
  type CouncilUtterance,
  classifyCouncilConsensus,
  councilMemberSupports,
  councilMemberSupportsSemantic,
  DEFAULT_COUNCIL_AGREE_AT,
  DEFAULT_COUNCIL_AGREE_AT_COSINE,
  type OutlierScreenOptions
} from "./council-consensus.js";
import {
  collapseEchoUtterances,
  dedupeUtterancesByPeer,
  rankUtterancesBySupport,
  screenCouncilOutliers,
  screenOffTopicUtterancesSemantic,
  screenUnfaithfulContributors
} from "./council-screening.js";
import { iterateJsonObjectCandidates } from "./json-array-scan.js";
import {
  classifyRetrievalConfidence,
  type GroundingReverify,
  judgeConsensus,
  type KnowledgeMatch
} from "./knowledge-recall.js";

export interface CouncilModelOptions {
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly model: string;
  readonly redact?: (text: string) => string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /**
   * Optional RGV re-verification (slice 5): after the id-citation gate, an
   * injected judge re-checks that the synthesis is supported by the TEXT of its
   * contributors' reasoning — dropping a "consensus" no member actually reached.
   * Omitted ⇒ id-gate only (back-compat).
   */
  readonly reverify?: GroundingReverify;
  /**
   * k judge samples for the synthesis re-verification (self-consistency,
   * arXiv:2203.11171). >1 collapses k verdicts unanimously (one NO drops the
   * synthesis) so a single flaky YES can't promote a baseless consensus —
   * parity with recall's `reverifySamples`. Clamped to [1,5]. Default 1 (single
   * judge, back-compat).
   */
  readonly reverifySamples?: number;
  /**
   * Optional embedder for semantic outlier screening (arXiv:2507.14649 — Cleanse).
   * When provided, `screenCouncilOutliers` uses embedding cosine instead of Jaccard
   * so cross-lingual and paraphrase agreement is not falsely quarantined.
   * Omitted ⇒ Jaccard path (back-compat, all existing callers unchanged).
   */
  readonly embed?: (text: string) => Promise<readonly number[]>;
}

const REASONING_SYSTEM_PROMPT = composeIdentityPrompt(
  "You are one member of a council of AI assistants reasoning about a shared question. " +
  "Give your concise reasoning and recommendation in 2-4 sentences — your perspective, not a final verdict. " +
  "Do NOT include any personal data, names, or private specifics; reason in general terms. Plain text only."
);

export interface CouncilAbstentionOptions {
  /** Absolute-cosine bar a member's corpus must clear to weigh in. Default `DEFAULT_CONFIDENT_AT`. */
  readonly confidentAt?: number;
}

/**
 * Council self-abstention — the multi-agent twin of "I'm not sure", extending the
 * fabrication=0 grounding invariant to a FIFTH surface (the peer DRAFT) at the
 * COLONY level. A member returns its `draft` only when its OWN corpus holds
 * CONFIDENT evidence for the question, and ABSTAINS (returns "") otherwise — so an
 * ignorant peer stays silent instead of injecting a confident-but-ungrounded
 * opinion that `synthesizeCouncilAnswer` might fold in (the classic
 * multi-agent-debate failure: a member with no relevant knowledge still emits a
 * plausible opinion).
 *
 * The signal is RETRIEVAL CONFIDENCE over the member's own corpus (the same CRAG
 * gate the recall wedge uses), NOT token-coverage of the draft: the council
 * reasons in GENERAL terms by design (the system prompt forbids quoting private
 * specifics), so a coverage gate would silence every member (over-abstention). A
 * member with a CONFIDENT match speaks; `none`/`ambiguous` (no corpus, or only a
 * weak off-corpus near-miss) abstains — selective, not blanket silence, and
 * DETERMINISTIC (the CRAG verdict decides, never the stochastic 8B). Purely
 * SUBTRACTIVE + entirely LOCAL: a member grounds against its own corpus, which
 * never crosses the wire — no new shareable kind, no inbound state change.
 */
export function abstainIfUngrounded(
  draft: string,
  matches: readonly KnowledgeMatch[],
  options?: CouncilAbstentionOptions
): string {
  if (draft.trim().length === 0) {
    return "";
  }
  return classifyRetrievalConfidence(matches, options) === "confident" ? draft : "";
}

/**
 * `produceCouncilReasoning` + self-abstention. Short-circuits to abstain (no model
 * call, no leaked generic opinion) when the member's corpus lacks confident
 * evidence for the question; otherwise produces the reasoning and gates it through
 * `abstainIfUngrounded`. Keeps `produceCouncilReasoning` untouched for back-compat.
 */
export async function produceGroundedCouncilReasoning(
  question: string,
  matches: readonly KnowledgeMatch[],
  options: CouncilModelOptions & { readonly abstention?: CouncilAbstentionOptions }
): Promise<string> {
  if (classifyRetrievalConfidence(matches, options.abstention) !== "confident") {
    return "";
  }
  const draft = await produceCouncilReasoning(question, options);
  return abstainIfUngrounded(draft, matches, options.abstention);
}

/** A participant's bounded reasoning utterance — short, PII-redacted, no tools. */
export async function produceCouncilReasoning(question: string, options: CouncilModelOptions): Promise<string> {
  if (question.trim().length === 0) return "";
  const redact = options.redact ?? redactSecretsInText;
  const messages: readonly ModelMessage[] = [
    { content: REASONING_SYSTEM_PROMPT, role: "system" },
    { content: `Council question:\n${redact(question)}`, role: "user" }
  ];
  const request: ModelRequest = {
    maxOutputTokens: options.maxOutputTokens ?? 200,
    messages,
    model: options.model,
    temperature: options.temperature ?? 0.5
  };
  try {
    const out = (await options.modelProvider.generate(request)).output?.trim() ?? "";
    return redact(out);
  } catch {
    return "";
  }
}

const SYNTHESIS_SYSTEM_PROMPT = composeIdentityPrompt(
  "You are synthesising a council of AI members' reasoning into one answer for the user. " +
  "Each member is labelled with its [id]. Use ONLY the members' reasoning below — do not add facts none of them raised. " +
  "Output ONLY a JSON object: {\"answer\": \"<2-4 sentence synthesis>\", \"contributors\": [\"<id>\", …]} " +
  "where contributors lists the member [id]s whose reasoning you actually used. " +
  "Never invent a member id that is not provided. No prose outside the JSON."
);

/** Render the council reasoning as an `[id] reasoning` list for the synthesiser. */
export function buildCouncilPrompt(question: string, utterances: readonly CouncilUtterance[]): string {
  const lines = utterances.map((u) => `[${u.peerId}] ${u.reasoning.replace(/\s+/gu, " ").trim()}`);
  return `Question: ${question}\n\nCouncil reasoning:\n${lines.join("\n")}`;
}

interface RawCouncilAnswer {
  readonly answer?: unknown;
  readonly contributors?: unknown;
}

/**
 * Parse + GROUND the synthesis. Keeps only contributor ids that are real council
 * members; an answer with no real contributors falls back to listing none. Pure.
 */
export function parseCouncilAnswer(raw: string, validPeerIds: ReadonlySet<string>): CouncilAnswer | null {
  // The synthesiser emits an OBJECT, often wrapped in prose. Walk each balanced
  // {…} span (string/escape-aware) and take the first that carries a real answer
  // — robust where first-`{`-to-last-`}` would swallow trailing brace-bearing
  // prose and fail the parse.
  for (const candidate of iterateJsonObjectCandidates(raw)) {
    const { answer, contributors } = candidate.value as RawCouncilAnswer;
    if (typeof answer !== "string" || answer.trim().length === 0) continue;
    const grounded = Array.isArray(contributors)
      ? [...new Set(contributors.filter((c): c is string => typeof c === "string" && validPeerIds.has(c)))]
      : [];
    return { answer: answer.trim(), contributors: grounded };
  }
  return null;
}

/** Synthesise the council's reasoning into one grounded answer. Needs ≥1 utterance. */
export async function synthesizeCouncilAnswer(
  question: string,
  utterances: readonly CouncilUtterance[],
  options: CouncilModelOptions
): Promise<CouncilAnswer | null> {
  const usable = dedupeUtterancesByPeer(utterances.filter((u) => u.peerId.length > 0 && u.reasoning.trim().length > 0));
  if (question.trim().length === 0 || usable.length === 0) return null;

  // Question-relevance gate (arXiv:2503.13657 — MAST FM-2.3 task derailment;
  // arXiv:2507.14649 — semantic cosine signal): drop off-topic peers before synthesis.
  // Semantic cosine natively handles KO paraphrase + cross-lingual on-topic peers
  // (no lexical token overlap needed). Skipped entirely when no embed — no lexical fallback
  // (a lexical fallback was the false-drop failure; absence is correct here).
  const offTopicExcluded: { peerId: string; reason: "off-topic" }[] = [];
  let onTopic: readonly CouncilUtterance[] = usable;
  if (options.embed) {
    const rel = await screenOffTopicUtterancesSemantic(question, usable, options.embed);
    onTopic = rel.kept.length > 0 ? rel.kept : usable;
    offTopicExcluded.push(...rel.excluded);
  }

  // Consensus-outlier screen (arXiv:2503.05856 + arXiv:2507.14649): quarantine divergent
  // peers before aggregation. When an embedder is injected, use semantic cosine support
  // (Cleanse) so cross-lingual/paraphrase-agreeing peers are not falsely quarantined.
  // Falls back to Jaccard when the embedder is absent or throws (fail-open).
  const forOutlier = onTopic.length > 0 ? onTopic : usable;
  let screenOpts: OutlierScreenOptions | undefined;
  if (options.embed) {
    try {
      const semanticSupports = await councilMemberSupportsSemantic(forOutlier, options.embed);
      screenOpts = { precomputedSupports: semanticSupports };
    } catch {
      // fall through — Jaccard path
    }
  }
  const { kept, excluded: outlierExcluded } = screenCouncilOutliers(forOutlier, screenOpts);
  // Never screen the entire panel away (the majority cap should prevent it, but
  // fall back to usable as a hard safety net).
  // Collapse cross-peer echoes AFTER the outlier screen (which needs the full panel
  // to compute pairwise support) but BEFORE synthesis/consensus — so a distinct-peer
  // echo can't double-weight one voice in the prompt or inflate the consensus label,
  // yet collapsing the agreeing majority never shrinks the outlier screen's input panel.
  const forSynthesis = collapseEchoUtterances(kept.length > 0 ? kept : forOutlier);

  // Roundtable salience ordering (arXiv:2509.16839 — Yao/Dong/Yang/Li/Du 2025):
  // order kept utterances by descending consensus support before synthesis so the
  // highest-consensus reasoning appears first in the synthesis model's context window.
  // Support is recomputed on forSynthesis (not projected from forOutlier) so the
  // vector is always correctly aligned to the kept subset. Mirror the screen's choice:
  // semantic cosine when embed is present, Jaccard otherwise.
  // Pick the floor from the support computation that ACTUALLY ran, not from
  // options.embed — so a fallback to Jaccard always pairs with the Jaccard floor and
  // the consensus label is never scored against a mismatched scale. (The catch is
  // currently unreachable — councilMemberSupportsSemantic never throws, it catches
  // embed errors per-member → support 0 — but tying the floor to the realised support
  // source keeps floor⊥support correct-by-construction if that ever changes.)
  let keptSupports: number[];
  let supportFloor: number;
  if (options.embed) {
    try {
      keptSupports = await councilMemberSupportsSemantic(forSynthesis, options.embed);
      supportFloor = DEFAULT_COUNCIL_AGREE_AT_COSINE;
    } catch {
      keptSupports = councilMemberSupports(forSynthesis);
      supportFloor = DEFAULT_COUNCIL_AGREE_AT;
    }
  } else {
    keptSupports = councilMemberSupports(forSynthesis);
    supportFloor = DEFAULT_COUNCIL_AGREE_AT;
  }
  const ordered = rankUtterancesBySupport(forSynthesis, keptSupports);

  // ConfMAD advisory (arXiv:2509.14034): carry the panel's aggregate confidence signal
  // forward. Advisory-only per arXiv:2511.07784 — never gates or alters the answer.
  const consensus = classifyCouncilConsensus(keptSupports, { floor: supportFloor });

  const messages: readonly ModelMessage[] = [
    { content: SYNTHESIS_SYSTEM_PROMPT, role: "system" },
    { content: buildCouncilPrompt(question, ordered), role: "user" }
  ];
  const request: ModelRequest = {
    maxOutputTokens: options.maxOutputTokens ?? 300,
    messages,
    model: options.model,
    temperature: options.temperature ?? 0.3
  };
  let output: string;
  try {
    output = (await options.modelProvider.generate(request)).output?.trim() ?? "";
  } catch {
    return null;
  }
  const parsed = parseCouncilAnswer(output, new Set(forSynthesis.map((u) => u.peerId)));
  // Drop a falsely-attributed contributor — a peer listed as a source whose
  // reasoning doesn't semantically support the answer (post-rationalization,
  // arXiv:2412.18004). Semantic + subtractive; only runs when an embedder is
  // present and there's more than one contributor to discriminate.
  const council = parsed && options.embed && parsed.contributors.length > 1
    ? { ...parsed, contributors: await screenUnfaithfulContributors(parsed.answer, parsed.contributors, forSynthesis, options.embed) }
    : parsed;
  const allExcluded = [...offTopicExcluded, ...outlierExcluded];
  const excludedPeers = allExcluded.length > 0 ? allExcluded : undefined;
  const withExcluded = council
    ? { ...council, consensus, ...(excludedPeers ? { excludedPeers } : {}) }
    : council;
  if (!withExcluded || !options.reverify) return withExcluded;
  const reverified = await verifyCouncilGrounding(withExcluded, question, forSynthesis, options.reverify, options.reverifySamples);
  return reverified ? { ...reverified, consensus, ...(excludedPeers ? { excludedPeers } : {}) } : reverified;
}

/**
 * RGV re-verification for the council surface: keep the synthesis ONLY when the
 * injected judge confirms it is supported by the TEXT of the contributors'
 * reasoning (falling back to all utterances when the synthesis named no
 * contributor). Like reflections, a synthesis abstracts across members, so the
 * one-shot judge — not the lexical rubric — is the right tool. Fail-close: a NO
 * verdict OR a judge error drops the synthesis (returns null), consistent with
 * the fail-soft council contract. Pure over the injected judge + exported.
 */
export async function verifyCouncilGrounding(
  council: CouncilAnswer,
  question: string,
  utterances: readonly CouncilUtterance[],
  reverify: GroundingReverify,
  reverifySamples?: number
): Promise<CouncilAnswer | null> {
  const cited = new Set(council.contributors);
  const drawnFrom = utterances.filter((u) => cited.size === 0 || cited.has(u.peerId));
  const evidence = drawnFrom.map((u) => u.reasoning.replace(/\s+/gu, " ").trim()).join("\n");
  // Empty evidence is unverifiable BY DEFINITION — there is no deterministic
  // rubric pre-gate here (the judge is the only gate), so a YES on "" would be a
  // pure fabrication-floor leak. Fail-close WITHOUT consulting the judge.
  if (evidence.trim().length === 0) {
    return null;
  }
  const samples = Math.min(5, Math.max(1, reverifySamples ?? 1));
  try {
    // Collect up to k verdicts, short-circuiting on the first NO (unanimous-keep):
    // one dissent among k samples drops the synthesis, so a single flaky YES on a
    // borderline consensus can't promote it (single-judge intra-rater variance).
    const verdicts: boolean[] = [];
    for (let i = 0; i < samples; i++) {
      const v = await reverify({ answer: council.answer, evidence, query: question });
      verdicts.push(v);
      if (!v) break;
    }
    return judgeConsensus(verdicts, "unanimous-keep") ? council : null;
  } catch {
    return null;
  }
}
