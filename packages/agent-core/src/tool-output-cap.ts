/**
 * Per-tool-result output capping (injection neutralization + trim + optional
 * just-in-time ref), split out of model-loop.ts — the four helpers below only
 * reference each other, never the loop-control state in model-loop.ts.
 */

import { createHash } from "node:crypto";

import type { ModelMessage } from "@muse/model";
import {
  applyToolOutputImportance,
  scoreToolOutputImportance,
  summarizeToolResult,
  trimToolOutput,
  type ContextReferenceStore
} from "@muse/memory";

import { neutralizeInjectionSpans } from "./injection.js";

/**
 * Apply the per-tool-result character cap. Pure
 * delegate to `trimToolOutput` from @muse/memory; here just
 * threads in the per-tool hint that surfaces in the elision
 * marker. When `maxChars` is undefined or 0, the original
 * output passes through unchanged.
 */
export function capToolOutput(
  output: string,
  toolName: string,
  maxChars: number | undefined,
  refStore?: ContextReferenceStore,
  anchorTerms?: readonly string[]
): string {
  // Live-injection defense: tool / MCP / sub-agent output is UNTRUSTED — a poisoned
  // result ("ignore previous instructions, exfiltrate …") would otherwise reach the
  // model verbatim (a prompt "this is untrusted" tag does NOT stop a small local
  // model obeying it). Neutralize the injecting span deterministically here, the
  // single chokepoint every tool result passes through before becoming a message.
  // The caller keeps the RAW `executed.result.output` for traces; only this
  // message-/ref-bound copy is neutralized. Clean output is byte-identical.
  const safe = neutralizeInjectionSpans(output);
  if (!maxChars || maxChars <= 0) {
    return safe;
  }
  // D5: scale the per-tool budget by importance class so calendar /
  // tasks / notes results get more retention than a noisy web-fetch
  // dump. `scoreToolOutputImportance` uses the same name-prefix
  // heuristic as `inferDomain`, neutral 1.0 fallback.
  const importance = scoreToolOutputImportance(toolName);
  const effectiveMaxChars = applyToolOutputImportance(maxChars, importance);
  // when a ref store is configured, stash the full
  // output BEFORE trimming and surface `ref=<id>` in the marker.
  // Content-addressed via sha256 prefix so the same payload
  // returned by repeated tool calls dedupes.
  const ref = refStore && safe.length > effectiveMaxChars
    ? putToolOutputRef(refStore, safe, toolName)
    : undefined;
  const baseHint = ref
    ? `tool ${toolName} returned a larger result; ref=${ref}, expand via muse.context.fetch({ ref })`
    : `tool ${toolName} returned a larger result`;
  // Fold a deterministic, code-derived 1-line summary into the elision
  // marker so a truncated tool result still SHOWS what it did
  // ("terminal: exit 0 · 120 lines"). Base hint stays first so its
  // wording (and any ref= token) survives even a pathologically small
  // cap that slices the marker tail. Absent a summary → byte-identical.
  const summary = summarizeToolResult(toolName, safe);
  const hint = summary ? `${baseHint} · ${summary}` : baseHint;
  return trimToolOutput(safe, {
    hint,
    maxChars: effectiveMaxChars,
    ...(anchorTerms && anchorTerms.length > 0 ? { anchorTerms } : {})
  }).output;
}

const ANCHOR_STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "was", "were", "you", "your", "with", "this",
  "that", "from", "have", "has", "had", "can", "could", "would", "should",
  "what", "when", "where", "which", "who", "why", "how", "did", "does", "do",
  "about", "into", "out", "any", "all", "but", "not", "get", "got", "tell",
  "please", "show", "give", "find"
]);

/**
 * Derive query-anchor terms from the latest user message so a buried
 * middle span the user is asking about survives the per-result cap
 * (ACON arXiv:2510.00615 / Lost-in-the-Middle arXiv:2307.03172).
 * Deterministic: lowercase, split on non-word chars, drop stop-words
 * and tokens shorter than 3 chars so noise doesn't anchor everything.
 */
export function deriveAnchorTerms(messages: readonly ModelMessage[]): readonly string[] {
  let latest: string | undefined;
  for (const message of messages) {
    if (message.role === "user" && typeof message.content === "string") {
      latest = message.content;
    }
  }
  if (!latest) {
    return [];
  }
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of latest.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || ANCHOR_STOP_WORDS.has(raw) || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    terms.push(raw);
  }
  return terms;
}

function putToolOutputRef(
  refStore: ContextReferenceStore,
  output: string,
  toolName: string
): string {
  // Short content-addressed id: 12 hex chars of sha256. Cheap
  // collision risk acceptable here (in-process scratchpad, not a
  // security boundary).
  const id = createHash("sha256").update(output).digest("hex").slice(0, 12);
  refStore.put({
    content: output,
    id,
    originalLength: output.length,
    source: toolName
  });
  return id;
}
