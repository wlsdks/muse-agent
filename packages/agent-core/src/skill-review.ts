/**
 * Session-end skill review (fork-and-review, after Hermes Agent).
 * Deterministic detection of which turns warrant authoring a reusable
 * SKILL, then ONE local-model generalisation per candidate. Slice 1
 * handles user corrections; the signal union leaves a seam for
 * complex-success in a later slice. Detection is a rule pass (a small
 * local model is an unreliable self-verifier, arXiv 2404.17140); only
 * generalisation uses the model.
 */

import type { ModelMessage, ModelProvider, ModelRequest } from "@muse/model";
import { redactSecretsInText } from "@muse/shared";

import { detectCorrections, type CorrectionExchange } from "./correction-distiller.js";
import type { SessionTurnLine } from "./episodic-summariser.js";

export type SkillReviewSignal = { readonly kind: "correction"; readonly exchange: CorrectionExchange };

export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface DetectSkillCandidatesOptions {
  readonly maxCandidates?: number;
}

export function detectSkillCandidates(
  turns: readonly SessionTurnLine[],
  options?: DetectSkillCandidatesOptions
): readonly SkillReviewSignal[] {
  const max = Math.max(1, Math.trunc(options?.maxCandidates ?? 2));
  return detectCorrections(turns, { maxExchanges: max }).map((exchange) => ({ exchange, kind: "correction" as const }));
}

export interface DraftSkillOptions {
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly model: string;
  readonly redact?: (text: string) => string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

const DRAFTER_SYSTEM_PROMPT =
  `You decide whether a moment where the user CORRECTED the assistant reveals a
reusable, multi-step PROCEDURE worth saving as a skill — NOT a one-off
preference (those are handled elsewhere). If it is only a preference or style
nudge, output exactly:
NONE
Otherwise output exactly these three fields and nothing else:
name: <short-kebab-case-name, e.g. export-then-attach>
description: <one line starting "Use when ..."; what triggers this skill>
body:
<numbered markdown steps generalising the procedure to similar future tasks>
No preamble, no code fences, no JSON.`;

export async function draftSkillFromSignal(
  signal: SkillReviewSignal,
  options: DraftSkillOptions
): Promise<SkillDraft | null> {
  const redact = options.redact ?? redactSecretsInText;
  const { exchange } = signal;
  const transcript = [
    exchange.request ? `user asked: ${redact(exchange.request)}` : undefined,
    `assistant answered: ${redact(exchange.priorAnswer)}`,
    `user corrected: ${redact(exchange.correction)}`
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  const messages: readonly ModelMessage[] = [
    { content: DRAFTER_SYSTEM_PROMPT, role: "system" },
    { content: transcript, role: "user" }
  ];
  const request: ModelRequest = {
    maxOutputTokens: options.maxOutputTokens ?? 320,
    messages,
    model: options.model,
    temperature: options.temperature ?? 0.3
  };

  let output: string;
  try {
    const response = await options.modelProvider.generate(request);
    output = (response.output ?? "").trim();
  } catch {
    return null;
  }
  return parseSkillDraft(output);
}

export interface ReviewSkillsOptions extends DraftSkillOptions {
  readonly maxCandidates?: number;
  /**
   * Persist a drafted skill. Returns the ACTIVE action (`create`/`patch`) +
   * the stored name, or `undefined` when the write was a skip / quarantine /
   * failure (those don't count as authored). Injected so this module stays
   * store-free — the caller wires `AuthoredSkillStore.writeOrPatch`, whose
   * risk-scan can quarantine a poisoned draft instead of activating it.
   */
  readonly writeDraft: (draft: SkillDraft) => Promise<{ readonly action: string; readonly name: string } | undefined>;
}

export interface ReviewSkillsResult {
  /** `"<name> (<action>)"` for each skill that became active this review. */
  readonly authored: readonly string[];
}

/**
 * The reusable skill-review pass: detect procedural corrections in the given
 * turns, draft a skill per candidate (one local-model call each), and persist
 * via the injected writer. Used by the background-review engine (live
 * conversation turns) and available to the CLI session-end path. Fail-soft per
 * skill — one bad write never loses the rest.
 */
export async function reviewSkillsFromTurns(
  turns: readonly SessionTurnLine[],
  options: ReviewSkillsOptions
): Promise<ReviewSkillsResult> {
  const signals = detectSkillCandidates(turns, { maxCandidates: options.maxCandidates ?? 2 });
  const authored: string[] = [];
  for (const signal of signals) {
    const draft = await draftSkillFromSignal(signal, options);
    if (!draft) continue;
    try {
      const written = await options.writeDraft(draft);
      if (written && (written.action === "create" || written.action === "patch")) {
        authored.push(`${written.name} (${written.action})`);
      }
    } catch {
      // fail-soft per skill
    }
  }
  return { authored };
}

export function parseSkillDraft(raw: string): SkillDraft | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /^NONE\b/u.test(trimmed)) return null;
  // Horizontal whitespace only (not `\s`) between the label and its
  // value: a blank `name:`/`description:` value must read as missing,
  // not let `\s*` cross the newline and absorb the next field's line
  // as the value (a silently mislabeled draft).
  const nameMatch = /^name:[^\S\n]*(.+)$/imu.exec(trimmed);
  const descMatch = /^description:[^\S\n]*(.+)$/imu.exec(trimmed);
  const bodyMatch = /^body:\s*\n?([\s\S]+)$/imu.exec(trimmed);
  const name = nameMatch?.[1]?.trim();
  const description = descMatch?.[1]?.trim();
  const body = bodyMatch?.[1]?.trim();
  if (!name || !description || !body) return null;
  return { body, description, name };
}
