import { readFile } from "node:fs/promises";

import { avoidedSourceKeys, readTrustLedger } from "@muse/stores";
import { isRecord, withBestEffort } from "@muse/shared";

import { applyInterruptionBudget, resolveInterruptionBudgetCaps, type InterruptionBudgetWiring } from "./interruption-gate.js";
import type { ProactiveNoticeSink } from "./proactive-notice-loop.js";

const SIGNAL_FIELDS = ["app", "window", "selected", "clipboard", "notifications"] as const;

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

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

/**
 * Knowledge-TRIGGERED ambient notice (SB-3 proactive connection). Where
 * `AmbientNoticeRule` needs the user to pre-author a match pattern, this
 * fires purely because the thing on screen connects to something the
 * user already wrote — no rule required. The `enrich` callback returns a
 * related-knowledge line (or `undefined` when nothing connects above its
 * own relevance threshold); the runner edge-fires it through the sink.
 */
export interface KnowledgeAmbientTrigger {
  readonly enrich: (query: string) => Promise<string | undefined> | string | undefined;
  /** Notice title; sink renders `${title}: ${related}`. Default below. */
  readonly title?: string;
}

const DEFAULT_KNOWLEDGE_TRIGGER_TITLE = "💡 From your second brain";

/**
 * The query used to look the active context up against the user's
 * knowledge corpus: the active WINDOW TITLE only. Deliberately
 * conservative — the app name alone is too coarse to connect on, and
 * selected text / clipboard are sensitive, so neither is used here. An
 * empty result (no window title) suppresses the knowledge trigger.
 */
export function knowledgeAmbientQuery(signal: AmbientSignal | undefined): string {
  return (signal?.window ?? "").trim();
}

const MATCH_FIELDS = ["app", "window", "selected", "clipboard", "notifications"] as const;

/**
 * Deterministic "why this fired" clause built ONLY from the rule's own
 * matched field/pattern pairs — the same evidence the match check just used,
 * verbatim, never model-invented text. Up to 2 pairs are named directly;
 * further pairs fold into a trailing "외 N개" count so a rule with many
 * match fields still yields a short clause.
 */
function formatMatchRationale(pairs: readonly (readonly [string, string])[]): string {
  const shown = pairs.slice(0, 2).map(([field, pattern]) => `${field}에 '${pattern}'`);
  const extra = pairs.length > 2 ? ` 외 ${(pairs.length - 2).toString()}개` : "";
  return `(${shown.join(", ")}${extra} 포함되어 매칭)`;
}

/**
 * Notices for every rule whose match patterns ALL appear (as
 * case-insensitive substrings) in the corresponding signal fields. A
 * rule with no patterns never fires (it must not match everything),
 * and a missing signal field never matches. A firing notice's text
 * carries a rationale clause naming the matched field/pattern
 * pair(s) — never omitted for a firing rule since a match always has
 * at least one pattern, but guarded rather than assumed.
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
      const text = patterns.length > 0 ? `${rule.message} ${formatMatchRationale(patterns)}` : rule.message;
      out.push({ kind: "ambient", ruleId: rule.id, text, title: rule.title });
    }
  }
  return out;
}

/**
 * Reads the user's ambient signal from a JSON file (e.g.
 * `~/.muse/ambient.json`) that an external OS helper writes — a
 * launchd/cron one-liner can dump the frontmost app / window title
 * there with zero native dependency. Fail-open: a missing / malformed
 * / empty file yields `undefined` (no notice), never throws.
 */
export class FileAmbientSignalSource implements AmbientSignalSource {
  constructor(private readonly file: string) {}

  async snapshot(): Promise<AmbientSignal | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) {
      return undefined;
    }
    const obj = parsed;
    const signal: Record<string, string> = {};
    for (const field of SIGNAL_FIELDS) {
      const value = stringField(obj, field);
      if (value !== undefined) {
        signal[field] = value;
      }
    }
    return Object.keys(signal).length > 0 ? signal : undefined;
  }
}

/**
 * Parse a JSON array of ambient-notice rules from a config string.
 * Each rule needs a non-empty `id`, string `title`/`message`, and at
 * least one `match` field — a rule with no patterns is dropped (it
 * would otherwise fire on everything). Fail-open: malformed JSON / a
 * non-array / an invalid entry is skipped, never throws.
 */
export function parseAmbientNoticeRules(raw: string): AmbientNoticeRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: AmbientNoticeRule[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      continue;
    }
    const e = entry;
    if (typeof e.id !== "string" || e.id.length === 0 || typeof e.title !== "string" || typeof e.message !== "string") {
      continue;
    }
    if (!isRecord(e.match)) {
      continue;
    }
    const matchObj = e.match;
    const match: Record<string, string> = {};
    for (const field of SIGNAL_FIELDS) {
      const value = stringField(matchObj, field);
      if (value !== undefined) {
        match[field] = value;
      }
    }
    if (Object.keys(match).length === 0) {
      continue;
    }
    out.push({ id: e.id, match, message: e.message, title: e.title });
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
export interface AmbientNoticeRunner {
  /** One perception tick: deliver notices for newly-matched rules. */
  tick(): Promise<RunAmbientNoticeTickSummary>;
}

/**
 * A stateful ambient runner for a CONTINUOUS daemon. Edge-triggered:
 * a rule fires when its condition first matches and does NOT re-fire
 * while the condition keeps matching (no per-tick spam); it RE-ARMS
 * once the condition clears, so a recurring context (the daily
 * standup window reappearing) notifies again. This is the correct
 * dedupe for a long-running tick — fire-once-forever
 * (`runAmbientNoticeTick` with a persisted set) would never re-notify.
 * Fail-soft: a throwing source yields no notices.
 */
export function createAmbientNoticeRunner(options: {
  readonly source: AmbientSignalSource;
  readonly rules: readonly AmbientNoticeRule[];
  readonly sink: ProactiveNoticeSink;
  /**
   * Optional knowledge enricher. When set, a firing notice appends a
   * "Related: …" line for what the user already wrote about what
   * they're looking at — keyed on the ambient signal (window / app /
   * selection). Called once per tick (only when something fires);
   * fail-soft.
   */
  readonly enrich?: (query: string) => Promise<string | undefined> | string | undefined;
  /**
   * Optional knowledge TRIGGER (SB-3). When set, the active window
   * title is looked up against the knowledge corpus EVERY tick; a
   * strong-enough connection edge-fires a standalone notice with no
   * pre-authored rule. Edge-triggered: the same connection does not
   * re-fire while it keeps surfacing, and re-arms once it clears (the
   * context changes or stops connecting). Independent of `enrich`,
   * which only decorates rule-fired notices.
   */
  readonly knowledgeTrigger?: KnowledgeAmbientTrigger;
  /**
   * Opt-in interruption budget (unset → identical to pre-budget behavior).
   * Within budget, a firing notice still reaches the sink exactly as before;
   * over budget, the sink is skipped and the notice lands in the digest
   * queue instead — the edge-trigger state still advances either way so a
   * suppressed rule doesn't re-fire every tick just because it never
   * actually reached the sink.
   */
  readonly interruptionBudget?: InterruptionBudgetWiring;
  /** Injectable clock for the budget ledger. Default `() => new Date()`. */
  readonly now?: () => Date;
}): AmbientNoticeRunner {
  let lastMatchedIds = new Set<string>();
  let lastKnowledgeKey: string | undefined;
  const now = options.now ?? ((): Date => new Date());
  // Gate a sink.deliver call through the budget when wired, else send it
  // plainly — a single seam both call sites below share. Returns whether the
  // caller should treat the notice as delivered (mark fired but don't count
  // it) or a genuine send. Rethrows a real delivery failure so each call
  // site's own catch keeps its existing "don't consume the edge" behavior.
  const deliverGated = async (
    notice: { readonly kind: string; readonly text: string; readonly title: string },
    sourceId: string,
    avoidedSources: ReadonlySet<string> | undefined
  ): Promise<{ readonly digested: boolean }> => {
    if (!options.interruptionBudget) {
      await options.sink.deliver(notice);
      return { digested: false };
    }
    const budget = options.interruptionBudget;
    const result = await applyInterruptionBudget({
      avoidedSources,
      caps: resolveInterruptionBudgetCaps(budget),
      deliver: async () => {
        await options.sink.deliver(notice);
      },
      digestFile: budget.digestFile,
      ...(budget.lastDeliveryFile ? { lastDeliveryFile: budget.lastDeliveryFile } : {}),
      ledgerFile: budget.ledgerFile,
      now: now(),
      source: "ambient-notice",
      sourceId,
      sourceKey: `ambient-notice:${sourceId}`,
      text: notice.text,
      title: notice.title
    });
    return { digested: result.outcome !== "delivered" };
  };
  return {
    async tick(): Promise<RunAmbientNoticeTickSummary> {
      let signal: AmbientSignal | undefined;
      try {
        signal = await options.source.snapshot();
      } catch {
        signal = undefined;
      }
      const matched = deriveAmbientNotices(signal, options.rules);
      const matchedIds = new Set(matched.map((notice) => notice.ruleId));
      const toFire = matched.filter((notice) => !lastMatchedIds.has(notice.ruleId));
      let related: string | undefined;
      if (toFire.length > 0 && options.enrich && signal) {
        const query = (signal.window ?? signal.app ?? signal.selected ?? "").trim();
        if (query.length > 0) {
          try {
            related = await options.enrich(query);
          } catch {
            related = undefined;
          }
        }
      }
      const newlyFired: string[] = [];
      // Carry forward already-fired rules that are STILL matching (they
      // stay deduped); a rule no longer matched is dropped so it re-arms.
      const nextMatched = new Set<string>();
      for (const id of matchedIds) {
        if (lastMatchedIds.has(id)) {
          nextMatched.add(id);
        }
      }
      // Read once per tick — a veto recorded mid-tick still waits for the
      // NEXT tick, matching the edge-trigger state's own tick granularity.
  const avoidedSources = options.interruptionBudget?.trustLedgerFile
    ? avoidedSourceKeys(await withBestEffort(readTrustLedger(options.interruptionBudget.trustLedgerFile), []))
        : undefined;

      let ruleDelivered = 0;
      for (const notice of toFire) {
        const text = related && related.trim().length > 0 ? `${notice.text} — Related: ${related}` : notice.text;
        try {
          const { digested } = await deliverGated({ kind: notice.kind, text, title: notice.title }, notice.ruleId, avoidedSources);
          if (!digested) ruleDelivered += 1;
          newlyFired.push(notice.ruleId);
          // Mark fired ONLY after a successful send OR a budget-suppressed
          // digest (both consume the edge): a genuine failed delivery
          // leaves the rule OUT so it re-fires next tick instead of being
          // lost, and an already-sent sibling stays in so it never
          // duplicates. Other notices still go out (per-notice catch).
          nextMatched.add(notice.ruleId);
        } catch {
          // delivery failed for this notice; the rest still fire
        }
      }
      lastMatchedIds = nextMatched;

      let knowledgeDelivered = 0;
      if (options.knowledgeTrigger) {
        const query = knowledgeAmbientQuery(signal);
        let related: string | undefined;
        if (query.length > 0) {
          try {
            related = (await options.knowledgeTrigger.enrich(query))?.trim();
          } catch {
            related = undefined;
          }
        }
        if (related && related.length > 0) {
          // Edge-trigger keyed on the surfaced connection: the same memory
          // does not re-fire while it keeps surfacing for the current
          // context; a different connection (or the same after a gap) fires.
          if (related !== lastKnowledgeKey) {
            try {
              const { digested } = await deliverGated(
                {
                  kind: "ambient",
                  text: related,
                  title: options.knowledgeTrigger.title ?? DEFAULT_KNOWLEDGE_TRIGGER_TITLE
                },
                "knowledge-trigger",
                avoidedSources
              );
              if (!digested) knowledgeDelivered = 1;
              // Mark deduped after a successful send OR a budget-suppressed
              // digest (both consume the edge): a genuine failed delivery
              // leaves it un-keyed so it re-fires next tick (mirrors the rule path).
              lastKnowledgeKey = related;
            } catch {
              // delivery failed; do not consume the edge
            }
          }
        } else {
          // No connection this tick → re-arm so a later connection fires.
          lastKnowledgeKey = undefined;
        }
      }

      return { delivered: ruleDelivered + knowledgeDelivered, firedRuleIds: [...nextMatched] };
    }
  };
}

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
