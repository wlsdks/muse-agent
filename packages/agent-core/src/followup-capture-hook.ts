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
  type ExtractFollowupPromisesOptions,
  type FollowupPromise
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
  /**
   * Optional LLM-fallback detector (step 5 of agent-self-followup.md).
   * Runs *after* the rule detector and contributes additional
   * promises that the regex pass missed. Caller is responsible for
   * gating this on env (`MUSE_FOLLOWUP_LLM_FALLBACK=true`) and the
   * per-day budget. Errors / empty returns are tolerated: the hook
   * carries on with just the rule-detector output.
   */
  readonly additionalDetector?: (text: string, now: Date) => Promise<readonly FollowupPromise[]>;
}

const DEFAULT_MAX = 8;
const MAX_SUMMARY_CHARS = 160;

/**
 * Strip C0/C1 control bytes (except newline + tab) from a followup
 * summary before persisting. Reason: the captured text comes from
 * the assistant turn, which may have echoed control sequences from
 * upstream tool output. Once persisted, the firing daemon routes
 * the summary out to messaging providers (Telegram / Slack / log)
 * — leaving ANSI / BEL / DEL in the payload corrupts the channel
 * and gives an attacker who controls tool output a way to mess
 * with the user's messaging stream.
 */
export function sanitizeFollowupSummary(raw: string): string {
  const stripped = raw.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
  if (stripped.length <= MAX_SUMMARY_CHARS) {
    return stripped;
  }
  let head = stripped.slice(0, MAX_SUMMARY_CHARS);
  // `slice` cuts on UTF-16 units; a boundary inside an astral
  // char (emoji / supplementary-plane) leaves a lone high surrogate.
  // The persisted summary is later routed to Telegram / Slack / log
  // — invalid UTF-8 in those frames 400s the channel or replaces
  // with U+FFFD. Drop the orphan.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return head;
}

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
      const anchor = now();
      const rulePromises = extractFollowupPromises(output, {
        now: anchor,
        // A queued+fired self-followup must be an actual commitment, not a
        // descriptive time mention (arXiv:2502.14321 commissive force).
        requireCommissive: true,
        ...(options.slotHours ? { slotHours: options.slotHours } : {})
      });
      let llmPromises: readonly FollowupPromise[] = [];
      if (options.additionalDetector) {
        try {
          llmPromises = await options.additionalDetector(output, anchor);
        } catch {
          // Detector errors must not block the rule-detector path.
          llmPromises = [];
        }
      }
      // Merge: rule-detector promises FIRST so they win the
      // minute-precision dedupe over the LLM fallback (rules carry
      // "high" confidence; LLM is a soft pin).
      const promises: readonly FollowupPromise[] = [...rulePromises, ...llmPromises];
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
          summary: sanitizeFollowupSummary(promise.originalText),
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
