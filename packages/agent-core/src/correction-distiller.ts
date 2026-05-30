/**
 * ReasoningBank (arXiv 2509.25140): a self-evolving agent distills reusable
 * strategies from its own experience and feeds them back into memory. Muse's
 * memory IS the ACE playbook, so this turns a moment where the user CORRECTED
 * the assistant into one generalised `[Learned Strategies]` entry for next time.
 *
 * The outcome signal is deliberately the RELIABLE one — an explicit user
 * correction — NOT an LLM self-judgement of success/failure: a small local
 * model is an unreliable self-verifier (arXiv 2404.17140), so detection is a
 * deterministic rule pass and only the generalisation step uses the model.
 */

import type { ModelMessage, ModelProvider, ModelRequest } from "@muse/model";
import { redactSecretsInText } from "@muse/shared";

import type { SessionTurnLine } from "./episodic-summariser.js";

export interface CorrectionExchange {
  /** The assistant turn the user pushed back on. */
  readonly priorAnswer: string;
  /** The user turn that corrected it. */
  readonly correction: string;
  /** The user's original request before the corrected answer, when present. */
  readonly request?: string;
}

// Conservative, precision-first: each pattern strongly signals "you got it
// wrong / do it differently", because a false positive writes a junk strategy
// into the playbook. Bare "wrong"/"instead" are intentionally excluded.
const CORRECTION_PATTERNS: readonly RegExp[] = [
  /\bno,?\s+(that'?s|that\s+is|it'?s)\b/iu,
  /\bthat'?s\s+(wrong|incorrect|not\s+right|not\s+what)/iu,
  /\bnot\s+what\s+i\s+(asked|meant|wanted|said)/iu,
  /\bi\s+(meant|said|asked\s+for)\b/iu,
  /\b(redo|try\s+again|do\s+it\s+again)\b/iu,
  /\bnot\s+like\s+that\b/iu,
  /그게\s*아니/u,
  /아니야|아니라고|아니에요|아니요/u,
  /^아니[ ,.]/u,
  /틀렸|틀린/u,
  /잘못(됐|했|된|이)/u,
  /다시\s*(해|써|작성|만들|정리|알려)/u,
  /(그렇게|그거|그건)\s*말고/u,
  /내\s*말은/u,
  /별로(야|네|다)/u
];

function isCorrectionTurn(text: string): boolean {
  return CORRECTION_PATTERNS.some((re) => re.test(text));
}

export interface DetectCorrectionsOptions {
  /** Cap exchanges returned per session (avoids playbook noise). Default 2. */
  readonly maxExchanges?: number;
}

export function detectCorrections(
  turns: readonly SessionTurnLine[],
  options?: DetectCorrectionsOptions
): readonly CorrectionExchange[] {
  const max = Math.max(1, Math.trunc(options?.maxExchanges ?? 2));
  const found: CorrectionExchange[] = [];
  for (let index = 1; index < turns.length; index += 1) {
    const turn = turns[index]!;
    const prior = turns[index - 1]!;
    if (turn.role !== "user" || prior.role !== "assistant" || !isCorrectionTurn(turn.content)) {
      continue;
    }
    const request = index >= 2 && turns[index - 2]!.role === "user" ? turns[index - 2]!.content : undefined;
    found.push({
      correction: turn.content,
      priorAnswer: prior.content,
      ...(request ? { request } : {})
    });
    if (found.length >= max) {
      break;
    }
  }
  return found;
}

export interface ApprovalExchange {
  /** The assistant turn the user endorsed. */
  readonly priorAnswer: string;
  /** The user turn that endorsed it. */
  readonly approval: string;
  /** The user's original request before the approved answer, when present. */
  readonly request?: string;
}

// Precision-first mirror of CORRECTION_PATTERNS: each is an UNAMBIGUOUS "you
// got it right", so a false positive can't inflate a junk strategy's reward.
// Bare "ok"/"thanks"/"good"/"좋아" are excluded — they acknowledge, they don't
// endorse.
const APPROVAL_PATTERNS: readonly RegExp[] = [
  /\bperfect\b/iu,
  /\bthat'?s\s+(it|perfect|exactly\s+(it|right|what\s+i\s+wanted))\b/iu,
  /\bexactly\s+(right|what\s+i\s+(wanted|needed|asked))/iu,
  /\bspot[\s-]?on\b/iu,
  /\bnailed\s+it\b/iu,
  /\b(love|loved)\s+it\b/iu,
  /\bjust\s+what\s+i\s+(wanted|needed|asked\s+for)\b/iu,
  /\bworks\s+(perfectly|great)\b/iu,
  /완벽(해|하|네|합니다|히)/u,
  /딱\s*(좋|이[야네]|맞)/u,
  /바로\s*그거/u,
  /(그게|그거)\s*맞아/u,
  /정확(해|히)/u,
  /훌륭(해|하|합니다)/u,
  /최고(야|네|예요|입니다)/u,
  /마음에\s*(들어|듭니다|든다)/u
];

function isApprovalTurn(text: string): boolean {
  return APPROVAL_PATTERNS.some((re) => re.test(text));
}

/**
 * Mirror of detectCorrections for the POSITIVE reward signal: a user turn that
 * explicitly endorses the assistant's prior answer. Drives the RL REINFORCE
 * step (the counterpart to correction-driven decay) — the strategy that
 * applied to the approved request earns standing.
 */
export function detectApprovals(
  turns: readonly SessionTurnLine[],
  options?: DetectCorrectionsOptions
): readonly ApprovalExchange[] {
  const max = Math.max(1, Math.trunc(options?.maxExchanges ?? 2));
  const found: ApprovalExchange[] = [];
  for (let index = 1; index < turns.length; index += 1) {
    const turn = turns[index]!;
    const prior = turns[index - 1]!;
    if (turn.role !== "user" || prior.role !== "assistant" || !isApprovalTurn(turn.content)) {
      continue;
    }
    const request = index >= 2 && turns[index - 2]!.role === "user" ? turns[index - 2]!.content : undefined;
    found.push({
      approval: turn.content,
      priorAnswer: prior.content,
      ...(request ? { request } : {})
    });
    if (found.length >= max) {
      break;
    }
  }
  return found;
}

export interface DistilledStrategy {
  readonly text: string;
  readonly tag?: string;
}

export interface DistillStrategyOptions {
  readonly modelProvider: ModelProvider;
  readonly model: string;
  readonly redact?: (text: string) => string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

const DISTILLER_SYSTEM_PROMPT =
  `You write ONE reusable working preference for Muse, learned from a moment
where the user CORRECTED the assistant. Generalise the lesson so it applies to
similar future requests — do NOT restate this exact content. Output exactly:
strategy: <one imperative sentence, e.g. "when asked to summarise, use bullet points not prose">
tag: <one short task-class tag like email/scheduling/notes, or "-" if none>
No preamble, no markdown, no JSON, no quotes.`;

export async function distillStrategyFromCorrection(
  exchange: CorrectionExchange,
  options: DistillStrategyOptions
): Promise<DistilledStrategy | undefined> {
  const redact = options.redact ?? redactSecretsInText;
  const transcript = [
    exchange.request ? `user asked: ${redact(exchange.request)}` : undefined,
    `assistant answered: ${redact(exchange.priorAnswer)}`,
    `user corrected: ${redact(exchange.correction)}`
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  const messages: readonly ModelMessage[] = [
    { content: DISTILLER_SYSTEM_PROMPT, role: "system" },
    { content: transcript, role: "user" }
  ];
  const request: ModelRequest = {
    maxOutputTokens: options.maxOutputTokens ?? 80,
    messages,
    model: options.model,
    temperature: options.temperature ?? 0.3
  };

  let output: string;
  try {
    const response = await options.modelProvider.generate(request);
    output = (response.output ?? "").trim();
  } catch {
    return undefined;
  }
  return parseDistilledStrategy(output);
}

function parseDistilledStrategy(raw: string): DistilledStrategy | undefined {
  if (raw.trim().length === 0) {
    return undefined;
  }
  const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  let text: string | undefined;
  let tag: string | undefined;
  for (const line of lines) {
    const strategyMatch = /^strategy:\s*(.+)$/iu.exec(line);
    if (strategyMatch && text === undefined) {
      text = strategyMatch[1]!.trim();
      continue;
    }
    const tagMatch = /^tag:\s*(.+)$/iu.exec(line);
    if (tagMatch && tag === undefined) {
      const value = tagMatch[1]!.trim();
      if (value.length > 0 && value !== "-") {
        tag = value;
      }
    }
  }
  if (!text || text.length === 0) {
    return undefined;
  }
  return tag ? { tag, text } : { text };
}
