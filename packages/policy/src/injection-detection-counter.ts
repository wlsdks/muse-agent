/**
 * Per-family counter store for prompt-injection
 * detections. The guard records every firing pattern's name (NOT
 * the raw input — that's a user secret); dashboards / structured
 * logs scrape the snapshot so operators can see "history-
 * poisoning fired 47× this week" instead of zero-signal blocks.
 *
 * In-memory by default. `bumpFrom(findings)` does the actual
 * accounting; the guard layer wires it on every detection.
 */

export interface InjectionDetectionFinding {
  readonly name: string;
  readonly count: number;
}

export interface InjectionDetectionCounterSnapshot {
  /** Per-family lifetime total. Keys are pattern family names. */
  readonly counts: Readonly<Record<string, number>>;
  /** Sum of every per-family count. Cheap rollup for dashboards. */
  readonly total: number;
  /** ISO timestamp of the most recent bump, undefined when never fired. */
  readonly lastFiredAt?: string;
}

export interface InjectionDetectionCounter {
  /**
   * Charge each finding against its pattern-family bucket. Returns
   * the post-bump snapshot so callers can fold it into a structured
   * log line in one pass. No-op when `findings` is empty.
   */
  bumpFrom(findings: readonly InjectionDetectionFinding[]): InjectionDetectionCounterSnapshot;
  /** Read-only view, sorted by descending count for display. */
  snapshot(): InjectionDetectionCounterSnapshot;
  /** Drop every counter — for test fixtures and admin reset. */
  reset(): void;
}

export interface InMemoryInjectionDetectionCounterOptions {
  readonly now?: () => Date;
}

export class InMemoryInjectionDetectionCounter implements InjectionDetectionCounter {
  private readonly counts = new Map<string, number>();
  private lastFiredAt: string | undefined;
  private readonly now: () => Date;

  constructor(options: InMemoryInjectionDetectionCounterOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  bumpFrom(findings: readonly InjectionDetectionFinding[]): InjectionDetectionCounterSnapshot {
    if (findings.length === 0) return this.snapshot();
    let appliedAny = false;
    for (const finding of findings) {
      // `count <= 0` returns false for NaN / Infinity (any comparison
      // with NaN is false), so without the finite guard a buggy
      // detector emitting NaN would poison the family bucket
      // (`prev + NaN === NaN`) and every subsequent snapshot — the
      // operator dashboard then shows `total: NaN` instead of "the
      // injection counters fired N times." Same posture as the
      // scheduler / token-cost finite-guards.
      if (!finding.name || !Number.isFinite(finding.count) || finding.count <= 0) continue;
      const prev = this.counts.get(finding.name) ?? 0;
      this.counts.set(finding.name, prev + finding.count);
      appliedAny = true;
    }
    if (appliedAny) {
      this.lastFiredAt = this.now().toISOString();
    }
    return this.snapshot();
  }

  snapshot(): InjectionDetectionCounterSnapshot {
    const counts: Record<string, number> = {};
    let total = 0;
    // Iterate the map in insertion order, but materialise into a
    // record keyed by family. Sorting happens at the dashboard /
    // CLI render layer — keeping snapshot pure means tests + log
    // lines see deterministic keys.
    for (const [name, count] of this.counts) {
      counts[name] = count;
      total += count;
    }
    return {
      counts,
      total,
      ...(this.lastFiredAt ? { lastFiredAt: this.lastFiredAt } : {})
    };
  }

  reset(): void {
    this.counts.clear();
    this.lastFiredAt = undefined;
  }
}
