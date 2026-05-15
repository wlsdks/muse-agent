/**
 * Goal 150 — accept a unique prefix of a job id wherever the CLI
 * asks for one. Job ids look like
 * `job_2026-05-15T15-12-30_a1b2c3d4` — the 8-char UUID tail makes
 * full copy-paste from `muse job list` tedious; matching `git
 * checkout abc1234` ergonomics is the obvious fix.
 *
 * Pure helper — no IO, no commander coupling — so it tests
 * directly. The caller (`commands-jobs.ts`) supplies the list of
 * known ids (from `readdir` on `~/.muse/jobs/`) and renders the
 * resolution outcome.
 */

export type JobIdResolution =
  | { readonly kind: "exact"; readonly id: string }
  | { readonly kind: "prefix"; readonly id: string }
  | { readonly kind: "ambiguous"; readonly matches: readonly string[] }
  | { readonly kind: "none" };

export function resolveJobIdByPrefix(input: string, allIds: readonly string[]): JobIdResolution {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { kind: "none" };
  if (allIds.includes(trimmed)) return { kind: "exact", id: trimmed };
  const matches = allIds.filter((id) => id.startsWith(trimmed));
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) {
    const only = matches[0];
    if (only !== undefined) return { kind: "prefix", id: only };
  }
  return { kind: "ambiguous", matches };
}
