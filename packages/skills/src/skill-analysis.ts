/**
 * Pure analysis/serialization helpers for authored skills — split out of
 * `authored-skill-store.ts` so the persistence class (IO, snapshots, cap
 * enforcement) and the content-analysis logic (risk scan, similarity,
 * subsumption, eviction ranking, job-reference matching) are independently
 * readable and testable.
 */

import type { Skill } from "./skill-contract.js";

export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface SkillRiskScan {
  readonly flagged: boolean;
  readonly reasons: readonly string[];
}

/**
 * Defense-in-depth for AUTO-authored skill bodies: they are distilled by the
 * local model from corrections that can echo UNTRUSTED tool output, then
 * auto-injected into later prompts. A poisoned body could carry a persistent
 * prompt-injection or a copy-paste-dangerous command. High-precision patterns
 * only — a normal procedural skill won't match — so a flag is a real signal,
 * not noise. The store quarantines a flagged body instead of activating it.
 *
 * Pattern adapted from OpenClaw's skill-workshop scan-before-activate (MIT) —
 * deterministic reimplementation for Muse, no code copied. See THIRD_PARTY_NOTICES.md.
 */
const SKILL_RISK_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: "prompt-injection", re: /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|prompts?)\b/iu },
  { label: "prompt-injection", re: /\bdisregard\s+(?:the\s+)?(?:above|prior|previous|earlier|system)\b/iu },
  { label: "prompt-injection", re: /\b(?:reveal|print|repeat|leak|show)\s+(?:me\s+)?(?:the\s+|your\s+)?system\s+prompt\b/iu },
  { label: "dangerous-shell", re: /\brm\s+-rf\b/iu },
  { label: "dangerous-shell", re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/iu },
  { label: "dangerous-shell", re: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&\s*\}\s*;/u },
  { label: "embedded-secret", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { label: "embedded-secret", re: /\bAKIA[0-9A-Z]{16}\b/u }
];

export function scanSkillBodyForRisks(body: string): SkillRiskScan {
  const reasons: string[] = [];
  for (const { label, re } of SKILL_RISK_PATTERNS) {
    if (re.test(body) && !reasons.includes(label)) reasons.push(label);
  }
  return { flagged: reasons.length > 0, reasons };
}

export function slugifySkillName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/\s+/gu, "-").replace(/[^a-z0-9-]+/gu, "");
  return slug.length > 0 ? slug.slice(0, 64) : "skill";
}

export function serializeAuthoredSkill(draft: SkillDraft, authoredAt: string, lastUsedAt?: string): string {
  const muse: Record<string, unknown> = { authored: true, authoredAt };
  if (lastUsedAt) muse.lastUsedAt = lastUsedAt;
  const metadata = JSON.stringify({ muse });
  return `---\nname: ${draft.name}\ndescription: ${draft.description}\nmetadata: ${metadata}\n---\n\n${draft.body.trim()}\n`;
}

/** Content tokens (lowercased, len≥3, split on non-alphanumeric) — shared by the
 *  name/description Jaccard match and the body-subsumption check. */
function skillContentTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 3));
}

export function defaultSimilarity(a: string, b: string): number {
  const sa = skillContentTokens(a);
  const sb = skillContentTokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/** Containment ratio at/above which a draft skill body counts as already covered.
 *  High (0.85) on purpose: only a near-TOTAL subset is skipped, so a draft that adds
 *  even a couple of genuinely new procedure tokens still authors — the false-skip tail
 *  (a short draft whose few tokens all happen to appear in a long skill) is bounded,
 *  and a skip is non-destructive (returns the existing skill, writes nothing). */
export const DEFAULT_SKILL_SUBSUMPTION_CONTAINMENT = 0.85;

/**
 * Is the `draftBody` (near-)entirely COVERED by `existingBody`? Voyager-style skill-
 * library novelty gate (arXiv:2305.16291): a newly-distilled skill whose procedure is
 * a subset of one already authored is a redundant near-duplicate. DIRECTIONAL
 * (containment `|draft ∩ existing| / |draft|`), unlike the symmetric name/description
 * Jaccard — so a redundant SUBSET draft is caught while a richer SUPERSET new skill is
 * never suppressed. Fail-OPEN: an empty body can't be judged → not subsumed (allow the
 * write). Pure + exported for direct coverage.
 */
export function skillBodyIsSubsumed(
  draftBody: string,
  existingBody: string,
  options: { readonly minContainment?: number } = {}
): boolean {
  const minContainment = Number.isFinite(options.minContainment) ? options.minContainment! : DEFAULT_SKILL_SUBSUMPTION_CONTAINMENT;
  const draft = skillContentTokens(draftBody);
  const existing = skillContentTokens(existingBody);
  if (draft.size === 0 || existing.size === 0) return false;
  let intersection = 0;
  for (const token of draft) {
    if (existing.has(token)) intersection += 1;
  }
  return intersection / draft.size >= minContainment;
}

/** Neutralise volatile timestamps so an unchanged content re-write is idempotent. */
export function stripTimestamps(text: string): string {
  return text
    .replace(/"authoredAt":"[^"]*"/u, '"authoredAt":""')
    .replace(/"lastUsedAt":"[^"]*"/u, '"lastUsedAt":""')
    .trim();
}

/** A skill projected to the signals that decide cap-overflow eviction order. */
export interface SkillEvictionEntry {
  readonly name: string;
  /** Has the skill ever been used (a `lastUsedAt` recorded)? */
  readonly used: boolean;
  /** Epoch-ms of last use, or authoredAt when never used. */
  readonly lastActiveMs: number;
}

/**
 * Eviction order (lowest-utility FIRST) for the authored-skill cap — value-aware,
 * not FIFO-by-age (SkillOps arXiv:2605.13716 utility-driven retire; TinyLFU
 * arXiv:1512.00727 value-aware cache eviction): a NEVER-used skill is evicted
 * before any ever-used one, ties broken least-recently-active first (LRU). So a
 * heavily-used old skill survives a never-used newer one. With no usage data
 * `lastActiveMs` is `authoredAt`, so it degrades to FIFO (strict superset, no
 * regression). Pure + exported for direct coverage.
 */
export function rankSkillsForEviction(entries: readonly SkillEvictionEntry[]): readonly string[] {
  return [...entries]
    .sort((a, b) => (Number(a.used) - Number(b.used)) || (a.lastActiveMs - b.lastActiveMs))
    .map((entry) => entry.name);
}

/**
 * Minimal, duck-typed shape of a scheduled job / standing objective that
 * might still need a skill to exist. Deliberately NOT imported from
 * `@muse/scheduler` — every field is optional and structurally compatible
 * with `ScheduledJob`, so a caller can pass real scheduler/objective records
 * straight through without this package taking a build dependency on
 * `packages/scheduler`.
 */
export interface SkillReferencingJob {
  readonly enabled?: boolean;
  readonly name?: string;
  readonly description?: string;
  readonly agentPrompt?: string;
  readonly toolArguments?: unknown;
  readonly tags?: readonly string[];
}

/**
 * Is `skill` still named by any job (scheduled job or standing objective)?
 * A referenced skill is exempt from idle pruning even at zero uses — mirrors
 * Hermes Agent curator's cron-reference exemption (`_cron_referenced_skills`,
 * MIT), which DELIBERATELY includes paused/disabled jobs too: "resuming or
 * the next fire must find it" — a job disabled today may be re-enabled
 * tomorrow, and a skill archived out from under it in the meantime is a
 * silent regression the user never asked for. So `enabled` is intentionally
 * NOT used to filter here (kept on the type for callers/future use, e.g.
 * surfacing which references are live vs. dormant).
 *
 * KNOWN LIMITATION: Muse has no structured skill<->job link today (no
 * `skillId` field on `ScheduledJob`), so this is a conservative
 * case-insensitive, word-boundary SUBSTRING match of the skill's name
 * against free-text job fields (`name`/`description`/`agentPrompt`/`tags`/
 * stringified `toolArguments`). Consequences: (a) a job that paraphrases a
 * skill instead of naming it produces a false negative (skill still gets
 * pruned) — acceptable, matches today's un-exempted behavior; (b) a job
 * whose text happens to mention the skill's name in an unrelated sense
 * produces a false positive (skill over-exempted) — the safe direction,
 * since over-retaining a skill costs disk, not correctness. Replace with an
 * exact `skillId` match the day a structured link exists.
 */
export function referencedByScheduledJob(skill: Skill, jobs: readonly SkillReferencingJob[]): boolean {
  const needle = skill.name.trim().toLowerCase();
  if (needle.length === 0) return false;
  const pattern = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu");
  for (const job of jobs) {
    const haystacks: unknown[] = [job.name, job.description, job.agentPrompt, ...(job.tags ?? [])];
    if (job.toolArguments !== undefined) {
      try {
        haystacks.push(JSON.stringify(job.toolArguments));
      } catch {
        // non-serializable arguments — ignore, other fields still checked
      }
    }
    for (const text of haystacks) {
      if (typeof text === "string" && pattern.test(text)) return true;
    }
  }
  return false;
}

/** One archived-content record inside a {@link SkillSnapshot}. */
export interface SkillSnapshotEntry {
  readonly name: string;
  readonly slug: string;
  readonly contentHash: string;
  readonly content: string;
}

/** A pre-mutation snapshot taken before `curate`/`consolidate` archives skills. */
export interface SkillSnapshot {
  readonly id: string;
  readonly createdAt: string;
  readonly entries: readonly SkillSnapshotEntry[];
}
