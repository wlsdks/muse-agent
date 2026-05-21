/**
 * In-process content-by-reference store (Context Engineering 1.d,
 * 
 *
 * The premise from Anthropic's effective-context-engineering audit:
 * keep lightweight identifiers in context and let the agent pull
 * bytes via tools on demand. When a tool returns more content than
 * the per-tool cap, the truncation marker can stash
 * the full content here under a short reference id; the agent can
 * later call `muse.context.fetch(ref)` to expand the elided bytes
 * exactly when (and only when) needed.
 *
 * Design rules:
 *   - In-process Map keyed by `id` (no DB persistence — references
 *     are valid only for the run that created them).
 *   - TTL eviction so a long-running process doesn't accumulate
 *     stale large blobs. Default 30 minutes — long enough for the
 *     agent to traverse a multi-step task, short enough that
 *     references don't pin memory across sessions.
 *   - Bounded entry count so a runaway tool can't pin unbounded
 *     memory. Default 1_000 entries — tail-eviction by oldest
 *     `createdAt` when the cap is hit.
 *   - `id` is opaque — caller passes its own (typically a sha256
 *     prefix or a counter); the store doesn't generate ids itself
 *     to keep the test surface deterministic.
 */

export interface ContextReference {
  readonly id: string;
  readonly content: string;
  readonly contentType?: string;
  readonly createdAt: Date;
  /** Caller-supplied tag — typically the source tool name. */
  readonly source?: string;
  /**
   * Original byte size before any truncation. Useful for the
   * agent to decide whether the full fetch is worth the budget.
   */
  readonly originalLength?: number;
}

export interface ContextReferenceStore {
  put(input: Omit<ContextReference, "createdAt">): ContextReference;
  get(id: string): ContextReference | undefined;
  delete(id: string): boolean;
  list(): readonly ContextReference[];
  /** Drop entries older than the TTL. Idempotent. */
  pruneExpired(now?: Date): number;
}

export interface InMemoryContextReferenceStoreOptions {
  /** TTL in milliseconds. Defaults to 30 minutes. */
  readonly ttlMs?: number;
  /** Hard cap on entries; oldest evicted first when reached. */
  readonly maxEntries?: number;
  /** Override clock — useful for tests. */
  readonly now?: () => Date;
}

const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 1_000;

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export class InMemoryContextReferenceStore implements ContextReferenceStore {
  private readonly entries = new Map<string, ContextReference>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;

  constructor(options: InMemoryContextReferenceStoreOptions = {}) {
    // `??` doesn't catch NaN / Infinity. The downstream `entries.size
    // <= this.maxEntries` and `now - createdAt >= this.ttlMs` guards
    // both compare against the option directly: with NaN they short-
    // circuit (every comparison with NaN is false), which makes a
    // single corrupt option either silently empty the cache on every
    // put (maxEntries:NaN — eviction loop never breaks → all keys get
    // deleted) OR make every entry permanent (ttlMs:NaN — isExpired
    // returns false forever). Same posture as the response cache's
    // finite guard.
    this.ttlMs = Math.max(0, finiteOrDefault(options.ttlMs, DEFAULT_TTL_MS));
    this.maxEntries = Math.max(1, finiteOrDefault(options.maxEntries, DEFAULT_MAX_ENTRIES));
    this.now = options.now ?? (() => new Date());
  }

  put(input: Omit<ContextReference, "createdAt">): ContextReference {
    if (!input.id || input.id.trim().length === 0) {
      throw new Error("ContextReferenceStore.put requires a non-empty id");
    }
    this.pruneExpired();
    const entry: ContextReference = {
      content: input.content,
      createdAt: this.now(),
      id: input.id,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(typeof input.originalLength === "number" ? { originalLength: input.originalLength } : {})
    };
    this.entries.set(entry.id, entry);
    this.evictIfOverCap();
    return entry;
  }

  get(id: string): ContextReference | undefined {
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }

  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  list(): readonly ContextReference[] {
    this.pruneExpired();
    return [...this.entries.values()];
  }

  pruneExpired(now: Date = this.now()): number {
    if (this.ttlMs === 0) {
      return 0;
    }
    let removed = 0;
    const cutoff = now.getTime() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.createdAt.getTime() < cutoff) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  private isExpired(entry: ContextReference): boolean {
    if (this.ttlMs === 0) {
      return false;
    }
    return this.now().getTime() - entry.createdAt.getTime() >= this.ttlMs;
  }

  private evictIfOverCap(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }
    // Oldest-first eviction. Map iteration is insertion order, so
    // the first keys are the oldest puts (modulo prior deletes).
    const overflow = this.entries.size - this.maxEntries;
    const ids: string[] = [];
    for (const id of this.entries.keys()) {
      if (ids.length >= overflow) {
        break;
      }
      ids.push(id);
    }
    for (const id of ids) {
      this.entries.delete(id);
    }
  }
}
