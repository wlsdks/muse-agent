/**
 * Consolidate several small, overlapping AUTHORED skills into one umbrella
 * skill — the self-improving "curator" merge (after Hermes' curator, which
 * folds narrow session skills into class-level umbrellas). One local-Qwen call
 * merges a cluster into a single skill covering all their cases, or returns
 * undefined (NONE) when they are NOT genuinely one skill — so unrelated skills
 * are never force-merged. The store archives (never deletes) the originals.
 *
 * Pattern adapted from Hermes Agent's curator umbrella-consolidation (MIT) —
 * reimplemented for Muse, no code copied. See THIRD_PARTY_NOTICES.md.
 */

import type { ModelMessage, ModelProvider, ModelRequest } from "@muse/model";
import { redactSecretsInText } from "@muse/shared";

import { parseSkillDraft, type SkillDraft } from "./skill-review.js";

export interface MergeSkillsOptions {
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly model: string;
  readonly redact?: (text: string) => string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

const MERGE_SYSTEM_PROMPT =
  `You are consolidating several SMALL, possibly-overlapping skills the assistant
wrote about itself. If they are genuinely the SAME KIND of task, merge them into
ONE umbrella skill covering all their cases — a clear name, a one-line
description starting "Use when ...", and a body with the combined steps
(subsections per case if useful). If they are NOT meaningfully a single skill,
output exactly: NONE — never force unrelated skills together. Output exactly:
name: <short-kebab-case>
description: <one line starting "Use when ...">
body:
<the merged skill body>
No preamble, no markdown fences, no JSON.`;

/**
 * Merge a cluster (>= 2 skills) into an umbrella SkillDraft, or undefined when
 * the cluster doesn't cohere (model says NONE) / fewer than 2 / the call fails.
 */
export async function mergeSkillsIntoUmbrella(
  cluster: readonly SkillDraft[],
  options: MergeSkillsOptions
): Promise<SkillDraft | undefined> {
  if (cluster.length < 2) return undefined;
  const redact = options.redact ?? redactSecretsInText;
  const input = cluster
    .map((skill, i) => `--- skill ${(i + 1).toString()}: ${skill.name} ---\n${redact(skill.description)}\n${redact(skill.body)}`)
    .join("\n\n");
  const messages: readonly ModelMessage[] = [
    { content: MERGE_SYSTEM_PROMPT, role: "system" },
    { content: input, role: "user" }
  ];
  const request: ModelRequest = {
    maxOutputTokens: options.maxOutputTokens ?? 400,
    messages,
    model: options.model,
    temperature: options.temperature ?? 0.3
  };
  let output: string;
  try {
    output = (await options.modelProvider.generate(request)).output?.trim() ?? "";
  } catch {
    return undefined;
  }
  return parseSkillDraft(output) ?? undefined;
}
