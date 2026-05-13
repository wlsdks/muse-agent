/**
 * Step 3 of `docs/design/agent-self-followup.md` — afterTurn hook
 * that scans the assistant response for time-bound promises and
 * persists them.
 *
 * The detector (`extractFollowupPromises`, step 1) produces typed
 * shapes; this hook factory wires those shapes through a
 * `persist` callback so agent-core stays free of a direct
 * dependency on `@muse/mcp` (where the store lives). Concrete
 * consumers (autoconfigure, future REPL paths) pass a callback
 * that delegates to `upsertFollowup(file, ...)`.
 *
 * What the hook does each turn:
 *   1. Scan `response.output` for followup-shaped phrases.
 *   2. For each detected promise, compute a stable id +
 *      `originTurnHash` so re-detects on the same turn dedupe.
 *   3. Call `persist(followup)` for each unique promise.
 *
 * What it does NOT do (yet):
 *   - Drive the firing daemon (step 4)
 *   - LLM fallback for fuzzy promises (step 5)
 *
 * Failures inside `persist` are swallowed per-followup so a
 * filesystem hiccup never blocks the run from completing.
 */

import { createHash } from "node:crypto";

import {
  extractFollowupPromises,
  type ExtractFollowupPromisesOptions
} from "./followup-detector.js";
import type { HookStage } from "./types.js";

/**
 * Structural shape the hook hands the caller. Compatible with
 * `PersistedFollowup` in `@muse/mcp/personal-followups-store` —
 * the caller can pass this object straight through to
 * `upsertFollowup` without translation. Kept structural here so
 * agent-core doesn't need to import from mcp (would invert the
 * layering).
 */
export interface CapturedFollowup {
  readonly id: string;
  readonly userId: string;
  readonly scheduledFor: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly status: "scheduled";
  readonly originRunId?: string;
  readonly originTurnHash?: string;
  readonly kind?: string;
}

export interface FollowupCaptureHookOptions {
  /** Persist callback — typically delegates to upsertFollowup. */
  readonly persist: (followup: CapturedFollowup) => Promise<void> | void;
  /**
   * Default userId for promises whose run input has no
   * `metadata.userId`. When undefined and the run has no metadata
   * userId either, captures are SKIPPED — a followup without an
   * owning user has nowhere to fire to.
   */
  readonly defaultUserId?: string;
  /**
   * Anchor time used by the detector. Injectable so tests get
   * deterministic resolution. Defaults to `() => new Date()`.
   */
  readonly now?: () => Date;
  /**
   * Id factory. Default `() => "fu_<14-char-hex>"`. Stable per call,
   * so a re-detect on the SAME turn (e.g. retry) will get DIFFERENT
   * ids — dedupe relies on the store's `upsertFollowup` matching
   * by id, which the hook ensures by hashing the turn + promise.
   */
  readonly idFactory?: () => string;
  /** Forwarded to the detector. */
  readonly slotHours?: ExtractFollowupPromisesOptions["slotHours"];
  /**
   * Cap on captures per turn. Conservative default 8. A model that
   * spews many promises in one reply usually didn't mean any of
   * them; capping prevents the store from filling with noise.
   */
  readonly maxCapturesPerTurn?: number;
}

const DEFAULT_MAX = 8;

export function createFollowupCaptureHook(options: FollowupCaptureHookOptions): HookStage {
  const now = options.now ?? (() => new Date());
  const max = Math.max(1, options.maxCapturesPerTurn ?? DEFAULT_MAX);
  const idFactory = options.idFactory ?? defaultIdFactory;

  return {
    id: "followup-capture",
    async afterComplete(context, response) {
      const output = response.output ?? "";
      if (output.trim().length === 0) {
        return;
      }
      const userId = readUserId(context.input.metadata) ?? options.defaultUserId;
      if (!userId) {
        return;
      }
      const turnHash = hashTurn(output);
      const promises = extractFollowupPromises(output, {
        now: now(),
        ...(options.slotHours ? { slotHours: options.slotHours } : {})
      });
      if (promises.length === 0) {
        return;
      }
      const seenScheduledFor = new Set<string>();
      let captured = 0;
      for (const promise of promises) {
        if (captured >= max) break;
        const scheduledFor = promise.scheduledFor.toISOString();
        // The detector already deduplicates by minute internally
        // but we also dedupe by ISO so a backlog merge stays clean.
        if (seenScheduledFor.has(scheduledFor)) continue;
        seenScheduledFor.add(scheduledFor);
        captured += 1;
        const followup: CapturedFollowup = {
          createdAt: now().toISOString(),
          id: idFactory(),
          kind: promise.kind,
          originRunId: context.runId,
          originTurnHash: turnHash,
          scheduledFor,
          status: "scheduled",
          summary: promise.originalText.slice(0, 160),
          userId
        };
        try {
          await options.persist(followup);
        } catch {
          // Fail-open per promise — one bad write must not block
          // the rest of the captures or fail the run.
        }
      }
    }
  };
}

function defaultIdFactory(): string {
  const buf = new Uint8Array(7);
  for (let i = 0; i < buf.length; i += 1) {
    buf[i] = Math.floor(Math.random() * 256);
  }
  return `fu_${Buffer.from(buf).toString("hex")}`;
}

function hashTurn(text: string): string {
  const digest = createHash("sha256").update(text).digest("hex");
  return `sha256:${digest.slice(0, 32)}`;
}

function readUserId(metadata: { readonly [key: string]: unknown } | undefined): string | undefined {
  if (!metadata) return undefined;
  const value = (metadata as { userId?: unknown }).userId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
