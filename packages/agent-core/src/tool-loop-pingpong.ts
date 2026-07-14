/**
 * Ping-pong loop guard — catches a model alternating between TWO tool calls
 * forever (A,B,A,B,A,B…) instead of converging.
 *
 * `ToolLoopProgressTracker` (tool-loop-progress.ts) only sees a same-output
 * STALL (A,A,A…); an alternation between two distinct calls never repeats
 * the same signature twice in a row, so it is invisible to that detector.
 * This is a genuinely different failure shape (openclaw's
 * `tool-loop-detection.ts` calls it out as its own case) and needs its own
 * counter over the trailing exact-signature history.
 *
 * Unlike the post-compaction guard, this one is not `arm()`-gated: a
 * ping-pong doesn't need a compaction event to be a bug, so it counts from
 * the start of the run.
 */

import type { ModelToolCall } from "@muse/model";
import { isRecord } from "@muse/shared";

import { stableJson } from "./tool-call-deduplicator.js";

export const PINGPONG_WINDOW = 20;
export const PINGPONG_WARN = 6;
export const PINGPONG_BLOCK = 10;

export type PingPongLevel = "none" | "warn" | "block";

const VOLATILE_KEYS = new Set(["runId", "tsIso", "id", "ts", "timestamp"]);

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripVolatile(item));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = stripVolatile(val);
    }
    return out;
  }
  return value;
}

/**
 * Strips fields that differ every call even for the SAME logical action
 * (a fresh run id / timestamp on an otherwise-identical result), which
 * would otherwise hide a ping-pong behind cosmetic noise. Non-JSON output
 * is returned unchanged. Pure, never throws.
 */
export function stripVolatileFields(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  return JSON.stringify(stripVolatile(parsed));
}

/** Tool name + stable-hashed args + stable-hashed volatile-stripped result. */
export function buildPingPongSignature(toolCall: ModelToolCall, resultOutput: string): string {
  return `${toolCall.name}:${stableJson(toolCall.arguments)}:${stableJson(stripVolatileFields(resultOutput))}`;
}

/**
 * Length of the trailing strict two-value alternation (A,B,A,B,…, A ≠ B) in
 * `signatures`. A same-value run does not count (owned by the stall
 * detector), and a ≥3-value cycle does not count (out of scope — 2-value
 * alternation only).
 */
function trailingAlternationRun(signatures: readonly string[]): number {
  const n = signatures.length;
  if (n < 2) return n;
  let run = 2;
  if (signatures[n - 1] === signatures[n - 2]) return 0;
  for (let i = n - 1; i - 2 >= 0; i -= 1) {
    if (signatures[i] !== signatures[i - 1] && signatures[i] === signatures[i - 2]) {
      run += 1;
    } else {
      break;
    }
  }
  return run;
}

/**
 * "block" once the trailing alternation run reaches `block`, "warn" once it
 * reaches `warn`, else "none". Fewer than `warn` signatures never trips.
 * Pure, deterministic, never throws.
 */
export function detectPingPong(
  signatures: readonly string[],
  opts?: { readonly window?: number; readonly warn?: number; readonly block?: number }
): PingPongLevel {
  const window = Math.max(2, Math.trunc(opts?.window ?? PINGPONG_WINDOW));
  const warn = opts?.warn ?? PINGPONG_WARN;
  const block = opts?.block ?? PINGPONG_BLOCK;
  if (signatures.length < warn) return "none";
  const last = signatures.slice(-window);
  const run = trailingAlternationRun(last);
  if (run >= block) return "block";
  if (run >= warn) return "warn";
  return "none";
}

/**
 * Stateful wrapper for the tool loop: retains only the trailing `window`
 * signatures (flat memory) and reports the current alternation level on
 * each record. Not `arm()`-gated — counts from the first recorded call, so
 * before enough evidence accumulates it simply returns "none" and a normal
 * run is unaffected.
 */
export class PingPongLoopGuard {
  private signatures: string[] = [];
  private readonly window: number;
  private readonly warn: number;
  private readonly block: number;

  constructor(opts?: { readonly window?: number; readonly warn?: number; readonly block?: number }) {
    this.window = opts?.window ?? PINGPONG_WINDOW;
    this.warn = opts?.warn ?? PINGPONG_WARN;
    this.block = opts?.block ?? PINGPONG_BLOCK;
  }

  record(signature: string): PingPongLevel {
    this.signatures.push(signature);
    if (this.signatures.length > this.window) {
      this.signatures = this.signatures.slice(-this.window);
    }
    return detectPingPong(this.signatures, { block: this.block, warn: this.warn, window: this.window });
  }
}
