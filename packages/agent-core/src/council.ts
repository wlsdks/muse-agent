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
import { redactSecretsInText } from "@muse/shared";

import { iterateJsonObjectCandidates } from "./json-array-scan.js";
import {
  classifyRetrievalConfidence,
  type GroundingReverify,
  type KnowledgeMatch
} from "./knowledge-recall.js";

export interface CouncilUtterance {
  /** The participating peer's id (e.g. "phone", "alice"). */
  readonly peerId: string;
  /** Their reasoning about the question. */
  readonly reasoning: string;
}

export interface CouncilAnswer {
  readonly answer: string;
  /** Peer ids whose reasoning the answer drew on — always a subset of the inputs. */
  readonly contributors: readonly string[];
}

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
}

const REASONING_SYSTEM_PROMPT =
  "You are one member of a council of AI assistants reasoning about a shared question. " +
  "Give your concise reasoning and recommendation in 2-4 sentences — your perspective, not a final verdict. " +
  "Do NOT include any personal data, names, or private specifics; reason in general terms. Plain text only.";

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

const SYNTHESIS_SYSTEM_PROMPT =
  "You are Muse, synthesising a council of AI members' reasoning into one answer for the user. " +
  "Each member is labelled with its [id]. Use ONLY the members' reasoning below — do not add facts none of them raised. " +
  "Output ONLY a JSON object: {\"answer\": \"<2-4 sentence synthesis>\", \"contributors\": [\"<id>\", …]} " +
  "where contributors lists the member [id]s whose reasoning you actually used. " +
  "Never invent a member id that is not provided. No prose outside the JSON.";

/**
 * Build the round-2+ debate question for one member — the original question plus
 * a digest of the OTHER members' reasoning, asking it to refine its view in light
 * of theirs (Multiagent Debate, Du et al. 2023, arXiv:2305.14325: agents that see
 * and respond to each other's reasoning across rounds reach better-supported
 * answers). Returns the original question unchanged when no other members spoke.
 */
export function buildDebateQuestion(question: string, ownPeerId: string, utterances: readonly CouncilUtterance[]): string {
  const others = utterances.filter((u) => u.peerId !== ownPeerId && u.reasoning.trim().length > 0);
  if (others.length === 0) return question;
  const digest = others.map((u) => `[${u.peerId}] ${u.reasoning.replace(/\s+/gu, " ").trim()}`).join("\n");
  return `${question}\n\nOther council members reasoned:\n${digest}\n\n` +
    "Refine YOUR reasoning in light of theirs — agree, push back, or sharpen it. " +
    "2-4 sentences, plain text, no personal data.";
}

/**
 * One member, one voice: collapse utterances to a single one per peerId (last
 * wins — a peer's latest/retried reasoning supersedes an earlier one). Without
 * this a duplicate peer (a dup registry entry, or the initiator's selfId
 * colliding with a peer id) would be double-weighted in the synthesis — a MAST
 * duplicated-work failure that skews a deliberation. Preserves first-seen order.
 */
export function dedupeUtterancesByPeer(utterances: readonly CouncilUtterance[]): readonly CouncilUtterance[] {
  const byPeer = new Map<string, CouncilUtterance>();
  for (const u of utterances) byPeer.set(u.peerId, u);
  return [...byPeer.values()];
}

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
  const messages: readonly ModelMessage[] = [
    { content: SYNTHESIS_SYSTEM_PROMPT, role: "system" },
    { content: buildCouncilPrompt(question, usable), role: "user" }
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
  const council = parseCouncilAnswer(output, new Set(usable.map((u) => u.peerId)));
  if (!council || !options.reverify) return council;
  return verifyCouncilGrounding(council, question, usable, options.reverify);
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
  reverify: GroundingReverify
): Promise<CouncilAnswer | null> {
  const cited = new Set(council.contributors);
  const drawnFrom = utterances.filter((u) => cited.size === 0 || cited.has(u.peerId));
  const evidence = drawnFrom.map((u) => u.reasoning.replace(/\s+/gu, " ").trim()).join("\n");
  try {
    return (await reverify({ answer: council.answer, evidence, query: question })) ? council : null;
  } catch {
    return null;
  }
}
