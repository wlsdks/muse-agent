/**
 * Wall-clock stage accumulator for the ask pipeline — the first per-stage
 * latency breakdown (retrieval vs generation vs verdict), recorded onto the
 * run-log trace so the next performance lever is data-driven, not assumed.
 */
export function createStageTimer(now: () => number = () => Date.now()): {
  readonly mark: (stage: string) => void;
  readonly timings: () => Record<string, number>;
} {
  const startedAt = now();
  let last = startedAt;
  const stages: Record<string, number> = {};
  return {
    mark: (stage) => {
      const at = now();
      stages[stage] = (stages[stage] ?? 0) + (at - last);
      last = at;
    },
    timings: () => ({ ...stages, totalMs: now() - startedAt })
  };
}

export type AskOutcome = "abstain" | "grounded" | "misgrounded" | "ungrounded" | null;

/**
 * The outcome label lifted onto a cli.local run-log trace. A refusal is an
 * `abstain` (the gate held — distinct from an answer that failed the rubric),
 * otherwise the rubric verdict passes through; `null` means the verdict never
 * ran this turn (json mode / vision skip).
 */
export function askOutcomeLabel(args: {
  readonly refusal: boolean;
  readonly verdict: "grounded" | "ungrounded" | null;
}): AskOutcome {
  if (args.refusal) return "abstain";
  return args.verdict;
}

/**
 * The per-sentence unsupported fraction at or above which a `grounded` answer is
 * downgraded to `misgrounded`: half the answer's content sentences unbacked
 * despite the gate's pass is a confident misgrounding — the failure class that
 * otherwise hides as a `grounded` success and starves error-analysis of fuel
 * (GROUNDED != TRUE; the gate matched the claim to a REAL source, but the source
 * doesn't actually support it).
 */
export const DEFAULT_MISGROUNDING_FRACTION_FLOOR = 0.5;

/**
 * Downgrade a `grounded` verdict to `misgrounded` when the answer's unsupported
 * (assertive) sentence fraction lands in the band `[floor, 1)`. Only a `grounded`
 * outcome can hide a misgrounding; every other outcome is already honest and
 * passes through unchanged.
 *
 * The upper bound matters: a fraction of EXACTLY 1.0 (nothing the lexical probe
 * can see is supported, despite a grounded gate verdict) is a measurement
 * artifact — a cross-lingual answer scored against differently-worded evidence,
 * or heavy paraphrase the token-coverage probe can't match — NOT a confident
 * misgrounding. A real misgrounding shows PARTIAL grounding (some claims backed,
 * some not); requiring `< 1` keeps cross-lingual KO-answer/EN-note successes out
 * of the fuel. Pure — this relabels the run-log TRACE for fuel, NOT the
 * user-facing answer or the gate verdict.
 */
export function misgroundedOutcome(args: {
  readonly outcome: AskOutcome;
  readonly unsupportedFraction: number;
  readonly floor?: number;
}): AskOutcome {
  if (args.outcome !== "grounded") return args.outcome;
  const floor =
    typeof args.floor === "number" && Number.isFinite(args.floor) && args.floor > 0
      ? args.floor
      : DEFAULT_MISGROUNDING_FRACTION_FLOOR;
  return args.unsupportedFraction >= floor && args.unsupportedFraction < 1 ? "misgrounded" : "grounded";
}

/**
 * Whetstone fuel: the weakness axis (if any) an ask OUTCOME signals. `abstain`
 * (the gate held — couldn't ground the query in the user's corpus) and
 * `ungrounded` (an answer the rubric flagged as not backed) both mean the agent
 * couldn't answer this query from the user's own notes — a `grounding-gap`
 * worth logging as real-usage fuel (mirrors chat-repl's refusal → grounding-gap).
 * `grounded` and `null` (json/vision skip) are not failures.
 */
export type AskWeaknessAxis = "grounding-gap" | "misgrounding" | "unbacked-action";

/**
 * Whetstone fuel: the weakness axis (if any) an ask turn signals. Mirrors
 * chat-repl's precedence — an `unbacked-action` (the answer CLAIMED a tool
 * action the user asked for, but no actuator ran: a false promise) takes
 * precedence; otherwise `abstain` / `ungrounded` is a `grounding-gap`.
 *
 * A `grounding-gap` is a RECALL knowledge gap (the fix is "add a note"). An
 * ACTION request (`isActionRequest`) the ask path couldn't fulfil is NOT a
 * knowledge gap — it's either an unbacked-action (a false claim) or just "ask
 * couldn't act" (honest offer) — so it must NOT be logged as a grounding-gap, or
 * it pollutes the user-remediable fuel with "add a note about 치과 예약" nonsense
 * (a real probe recorded exactly that). A `misgrounded` outcome is a distinct
 * `misgrounding` axis — the user HAS the source, but the answer misused it, so it
 * is NOT a "add a note" gap; it survives an action request (a wrong fact is still
 * wrong) but yields to the worse `unbacked-action` false promise. `grounded` /
 * `null` are not failures.
 */
export function askWeaknessAxis(
  outcome: AskOutcome,
  opts: { readonly claimedUnbackedAction?: boolean; readonly isActionRequest?: boolean } = {}
): AskWeaknessAxis | null {
  if (opts.claimedUnbackedAction) {
    return "unbacked-action";
  }
  if (outcome === "misgrounded") {
    return "misgrounding";
  }
  if (opts.isActionRequest) {
    return null;
  }
  return outcome === "abstain" || outcome === "ungrounded" ? "grounding-gap" : null;
}

export interface AskWeaknessRecorderDeps {
  readonly recordWeakness: (file: string, signal: { readonly axis: AskWeaknessAxis; readonly message: string; readonly hint?: string }) => Promise<unknown>;
  readonly weaknessesFile: string;
}

/**
 * Feed an ask-path failure to the weakness ledger so `muse doctor` /
 * error-analysis can mine real-usage gaps. The ASK path previously only
 * run-logged its outcome; only chat-repl fed the ledger, so ask misses were
 * invisible fuel. Best-effort: a null axis or an empty query records nothing,
 * and a throwing ledger write is swallowed — a fuel write must never surface as
 * an ask error. Deps injected for testing; the live caller lazy-imports
 * @muse/mcp + @muse/autoconfigure.
 */
export async function recordAskWeakness(query: string, axis: AskWeaknessAxis | null, deps: AskWeaknessRecorderDeps, hint?: string): Promise<void> {
  if (!axis || query.trim().length === 0) {
    return;
  }
  try {
    await deps.recordWeakness(deps.weaknessesFile, { axis, message: query, ...(hint ? { hint } : {}) });
  } catch {
    // a ledger write must never break the ask command
  }
}

export interface AskWeaknessResolverDeps {
  readonly recordWeaknessResolved: (file: string, message: string) => Promise<unknown>;
  readonly weaknessesFile: string;
}

/**
 * Feed a successful grounded answer to the weakness ledger's BKT mastery estimator so
 * topics the user asks about repeatedly, but that Muse now answers correctly, can
 * graduate out of the recap/doctor nudge list. Best-effort — a throwing ledger write
 * must never break the ask command. Deps injected for testing.
 */
export async function recordAskWeaknessResolved(query: string, deps: AskWeaknessResolverDeps): Promise<void> {
  if (query.trim().length === 0) {
    return;
  }
  try {
    await deps.recordWeaknessResolved(deps.weaknessesFile, query);
  } catch {
    // a ledger write must never break the ask command
  }
}
