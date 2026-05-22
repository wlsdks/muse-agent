import type { ProactiveNoticeSink } from "./proactive-notice-loop.js";

/**
 * Ambient-signal → proactive notice (P20 perception). A tick reads a
 * continuous ambient signal (frontmost app / window title / selected
 * text / clipboard / notifications) and, WITHOUT the user invoking
 * anything, delivers a proactive notice when a user-defined rule
 * matches — through the same `ProactiveNoticeSink` the rest of the
 * proactive loop uses.
 *
 * Structural ambient shape (mirrors `@muse/agent-core`'s
 * `AmbientSnapshot`) so this stays inside `@muse/mcp` without taking
 * a dependency on `@muse/agent-core` — the request-path
 * `AmbientSnapshotProvider` is structurally assignable to
 * `AmbientSignalSource`.
 */
export interface AmbientSignal {
  readonly app?: string;
  readonly window?: string;
  readonly selected?: string;
  readonly clipboard?: string;
  readonly notifications?: string;
}

export interface AmbientSignalSource {
  snapshot(): Promise<AmbientSignal | undefined> | AmbientSignal | undefined;
}

export interface AmbientNoticeRule {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  /** Case-insensitive substring patterns; ALL named fields must match. */
  readonly match: {
    readonly app?: string;
    readonly window?: string;
    readonly selected?: string;
    readonly clipboard?: string;
    readonly notifications?: string;
  };
}

export interface AmbientNotice {
  readonly ruleId: string;
  readonly title: string;
  readonly text: string;
  readonly kind: string;
}

const MATCH_FIELDS = ["app", "window", "selected", "clipboard", "notifications"] as const;

/**
 * Notices for every rule whose match patterns ALL appear (as
 * case-insensitive substrings) in the corresponding signal fields. A
 * rule with no patterns never fires (it must not match everything),
 * and a missing signal field never matches.
 */
export function deriveAmbientNotices(
  signal: AmbientSignal | undefined,
  rules: readonly AmbientNoticeRule[]
): AmbientNotice[] {
  if (!signal) {
    return [];
  }
  const out: AmbientNotice[] = [];
  for (const rule of rules) {
    const patterns = MATCH_FIELDS
      .map((field) => [field, rule.match[field]] as const)
      .filter((entry): entry is readonly [(typeof MATCH_FIELDS)[number], string] =>
        typeof entry[1] === "string" && entry[1].length > 0);
    if (patterns.length === 0) {
      continue;
    }
    const matched = patterns.every(([field, pattern]) => {
      const value = signal[field];
      return typeof value === "string" && value.toLowerCase().includes(pattern.toLowerCase());
    });
    if (matched) {
      out.push({ kind: "ambient", ruleId: rule.id, text: rule.message, title: rule.title });
    }
  }
  return out;
}

export interface RunAmbientNoticeTickOptions {
  readonly source: AmbientSignalSource;
  readonly rules: readonly AmbientNoticeRule[];
  readonly sink: ProactiveNoticeSink;
  /** Rule ids already delivered — not re-fired this tick (dedupe). */
  readonly alreadyFiredRuleIds?: readonly string[];
}

export interface RunAmbientNoticeTickSummary {
  readonly delivered: number;
  readonly firedRuleIds: readonly string[];
}

/**
 * One ambient perception tick: read the signal, derive matching
 * notices, deliver the not-yet-fired ones through the sink, and
 * return the cumulative fired-rule set so the caller can persist it
 * (a rule fires once until its id is cleared — no per-tick spam).
 * Fail-soft: a source that throws yields no notices.
 */
export async function runAmbientNoticeTick(
  options: RunAmbientNoticeTickOptions
): Promise<RunAmbientNoticeTickSummary> {
  let signal: AmbientSignal | undefined;
  try {
    signal = await options.source.snapshot();
  } catch {
    signal = undefined;
  }
  const fired = new Set(options.alreadyFiredRuleIds ?? []);
  const newlyFired: string[] = [];
  for (const notice of deriveAmbientNotices(signal, options.rules)) {
    if (fired.has(notice.ruleId)) {
      continue;
    }
    await options.sink.deliver({ kind: notice.kind, text: notice.text, title: notice.title });
    newlyFired.push(notice.ruleId);
  }
  return { delivered: newlyFired.length, firedRuleIds: [...fired, ...newlyFired] };
}
