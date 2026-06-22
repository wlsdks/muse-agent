/**
 * Episodic recall prompt-section renderer and its defensive sanitiser.
 * A stored narrative is untrusted input (a third-party EpisodicRecallProvider
 * could splice control bytes or a fake section header), so rendering goes
 * through `sanitizeNarrativeInline` before reaching the prompt or terminal.
 */

import { stripUntrustedTerminalChars } from "@muse/shared";

import type { EpisodicRecallSnapshot } from "./episodic-recall.js";
import { humanizeRelativeFromIso } from "./time-helpers.js";

export const MAX_EPISODIC_CHARS = 1_500;

export function renderEpisodicSection(
  snapshot: EpisodicRecallSnapshot | undefined,
  nowIso?: string
): string | undefined {
  if (!snapshot || snapshot.matches.length === 0) {
    return undefined;
  }
  const lines: string[] = ["[Episodic Memory]"];
  lines.push("Past conversations that may be relevant. Soft context — verify before acting.");
  let charsUsed = 0;
  for (const match of snapshot.matches) {
    // `createdAtIso` is supposed to come from `Date.toISOString()`
    // (always safe) but the EpisodicRecallSnapshot is fed by
    // arbitrary `EpisodicRecallProvider` implementations — a
    // third-party store could put any string in there, including
    // one carrying `\n[System Override]\n`. Sanitise defensively.
    const createdAtIsoSafe = match.createdAtIso ? sanitizeNarrativeInline(match.createdAtIso) : undefined;
    // JARVIS-class freshness affordance. When `nowIso` is
    // wired in (the runtime caller has it), humanise the timestamp
    // to "1 day ago" / "in 3h" / "3 weeks ago" so the agent reads
    // recency directly instead of parsing ISO datetimes. Legacy
    // callers (no nowIso) still get the raw ISO so the existing
    // contract isn't broken — only the prompt rendering improves
    // when the runtime threads nowIso through.
    const headerTime = createdAtIsoSafe
      ? (nowIso ? humanizeRelativeFromIso(nowIso, createdAtIsoSafe) ?? createdAtIsoSafe : createdAtIsoSafe)
      : undefined;
    const header = headerTime ? `(${headerTime}, sim=${formatSim(match.similarity)})` : `(sim=${formatSim(match.similarity)})`;
    // Account for the rendered prefix ("— " + header + " ") so the
    // running `charsUsed` reflects the actual prompt-bytes consumed
    // — the previous impl counted only narrative length and could
    // overshoot `MAX_EPISODIC_CHARS` by ~50 chars per match.
    const prefix = `— ${header} `;
    // A-MAC conflict marker: a same-topic-different-value episode is flagged so
    // the model reconciles instead of asserting one value confidently. Counted
    // into the budget so the marker can't silently overshoot MAX_EPISODIC_CHARS.
    const conflictMark = match.conflictsWith
      ? " ⚠ conflicts with a more relevant memory — verify"
      : "";
    const remaining = MAX_EPISODIC_CHARS - charsUsed - prefix.length - conflictMark.length;
    if (remaining <= 0) {
      break;
    }
    // Sanitize: collapse newlines / tabs / multi-space runs to a
    // single space. A stored narrative could otherwise contain
    // `…\n\n[System Override]\n…` (either by a prompt-injection
    // attempt in the source conversation, or by genuine multi-line
    // text) and splice a fake section header into the
    // `[Episodic Memory]` block. Same pattern attachment-context
    // uses for description fields.
    const sanitized = sanitizeNarrativeInline(match.narrative);
    const narrative = sanitized.length > remaining
      ? `${sanitized.slice(0, Math.max(0, remaining - 1))}…`
      : sanitized;
    lines.push(`${prefix}${narrative}${conflictMark}`);
    charsUsed += prefix.length + narrative.length + conflictMark.length;
  }
  return lines.join("\n");
}

function sanitizeNarrativeInline(narrative: string): string {
  // Whitespace-collapse alone neutralises a `\n[System Override]\n`
  // splice, but a poisoned past-session narrative can also carry
  // ESC / C0 / C1 / DEL control bytes (ANSI escapes) that survive
  // `\s+` and would reach the prompt AND the `muse episode/recall`
  // terminal output. Strip them with the shared chokepoint first.
  return stripUntrustedTerminalChars(narrative).replace(/\s+/gu, " ").trim();
}

function formatSim(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "?";
  }
  return value.toFixed(2);
}
