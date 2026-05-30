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
}

const REASONING_SYSTEM_PROMPT =
  "You are one member of a council of AI assistants reasoning about a shared question. " +
  "Give your concise reasoning and recommendation in 2-4 sentences — your perspective, not a final verdict. " +
  "Do NOT include any personal data, names, or private specifics; reason in general terms. Plain text only.";

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
  // The synthesiser emits an OBJECT; reuse the array scanner by wrapping isn't
  // needed — find the first {...}. extractJsonArray handles arrays; for an object
  // we scan manually but tolerantly.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { answer, contributors } = parsed as RawCouncilAnswer;
  if (typeof answer !== "string" || answer.trim().length === 0) return null;
  const grounded = Array.isArray(contributors)
    ? [...new Set(contributors.filter((c): c is string => typeof c === "string" && validPeerIds.has(c)))]
    : [];
  return { answer: answer.trim(), contributors: grounded };
}

/** Synthesise the council's reasoning into one grounded answer. Needs ≥1 utterance. */
export async function synthesizeCouncilAnswer(
  question: string,
  utterances: readonly CouncilUtterance[],
  options: CouncilModelOptions
): Promise<CouncilAnswer | null> {
  const usable = utterances.filter((u) => u.peerId.length > 0 && u.reasoning.trim().length > 0);
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
  return parseCouncilAnswer(output, new Set(usable.map((u) => u.peerId)));
}
