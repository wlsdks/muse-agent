import { redactSecretsInText, stripUntrustedTerminalChars } from "@muse/shared";

import { appendSystemSection } from "./runtime-helpers.js";
import type { AgentRunContext, AgentRunInput, Awaitable } from "./types.js";

/**
 * Ambient perception signals (frontmost app, window title, selected
 * text, clipboard, a notifications summary). Every field is operator-
 * environment-derived and therefore UNTRUSTED — a window title or
 * clipboard can carry a `\n[System Override]\n…` splice or ESC/C1
 * bytes, so the renderer sanitises each field the same way the other
 * context surfaces do.
 */
export interface AmbientSnapshot {
  readonly app?: string;
  readonly window?: string;
  readonly selected?: string;
  readonly clipboard?: string;
  readonly notifications?: string;
}

export interface AmbientSnapshotProvider {
  snapshot(): Awaitable<AmbientSnapshot | undefined>;
}

// app / window are short identifiers (binary name, terminal title);
// selected / clipboard / notifications can carry substantive
// content the user is reading or just pasted. Caps are deliberately
// generous for normal use, sharp enough to bound a pathological
// case (a multi-MB clipboard paste) from inflating the system
// prompt — same posture attachment-context.ts uses on its own
// per-field text inputs.
const MAX_APP_CHARS = 256;
const MAX_WINDOW_CHARS = 256;
const MAX_SELECTED_CHARS = 2048;
const MAX_CLIPBOARD_CHARS = 2048;
const MAX_NOTIFICATIONS_CHARS = 2048;

// Slice without splitting a surrogate pair: if the cut lands between a high+low
// surrogate (an emoji / astral char), drop the trailing lone high surrogate so
// the bounded field never emits a malformed `�`. Mirrors inbox-context's truncate.
function sliceWithoutSplittingSurrogate(value: string, end: number): string {
  const head = value.slice(0, end);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

function sanitizeAndBound(raw: string, max: number): string {
  // Pre-slice to 2*max BEFORE the regex pass so a multi-MB
  // clipboard doesn't burn whole-string CPU just to be truncated
  // to a few KB afterwards. Same shape as attachment-context.ts.
  const limited = raw.length > max * 2 ? sliceWithoutSplittingSurrogate(raw, max * 2) : raw;
  const sanitized = stripUntrustedTerminalChars(limited).replace(/\s+/gu, " ").trim();
  return sanitized.length > max ? `${sliceWithoutSplittingSurrogate(sanitized, max - 1)}…` : sanitized;
}

export function renderAmbientContextSection(snapshot: AmbientSnapshot | undefined): string | undefined {
  if (!snapshot) {
    return undefined;
  }
  // [key, raw, maxChars, secretBearing] — the CONTENT fields (selected text,
  // clipboard, notifications) routinely carry secrets (a copied `.env` line,
  // an API key, a password), so they're secret-redacted BEFORE injection so a
  // key never reaches the model context. app/window are UI titles (low risk;
  // redaction would mangle them). B3 gate-first: secret-skip the ambient reader.
  const fields: [string, string | undefined, number, boolean][] = [
    ["app", snapshot.app, MAX_APP_CHARS, false],
    ["window", snapshot.window, MAX_WINDOW_CHARS, false],
    ["selected", snapshot.selected, MAX_SELECTED_CHARS, true],
    ["clipboard", snapshot.clipboard, MAX_CLIPBOARD_CHARS, true],
    ["notifications", snapshot.notifications, MAX_NOTIFICATIONS_CHARS, true]
  ];
  const lines = ["[Ambient Context]"];
  for (const [key, raw, max, secretBearing] of fields) {
    if (raw === undefined) continue;
    const value = sanitizeAndBound(secretBearing ? redactSecretsInText(raw) : raw, max);
    if (value.length === 0) continue;
    lines.push(`${key}: ${value}`);
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

/**
 * Gated perception → run-context injection. Off unless `enabled` is
 * explicitly true (ambient capture is privacy-sensitive — opt-in
 * only, never default-on). When enabled AND the snapshot renders to
 * a non-empty block, prepend it as the `[Ambient Context]` system
 * section so the agent perceives the user's environment unasked.
 * Otherwise the input is returned unchanged.
 */
export function applyAmbientContext(
  context: AgentRunContext,
  snapshot: AmbientSnapshot | undefined,
  enabled: boolean
): AgentRunInput {
  if (!enabled) {
    return context.input;
  }
  const rendered = renderAmbientContextSection(snapshot);
  if (!rendered) {
    return context.input;
  }
  return {
    ...context.input,
    messages: appendSystemSection(context.input.messages, rendered, "ambient-context"),
    metadata: {
      ...context.input.metadata,
      ambientContextApplied: true
    }
  };
}

/**
 * Resolve the current ambient snapshot from a perception provider.
 * Fail-open: ambient perception is an enhancement, never a
 * correctness dependency — a disabled/absent provider or a thrown
 * snapshot yields `undefined` (the run proceeds with no ambient
 * block), it never breaks the run.
 */
export async function resolveAmbientSnapshot(
  provider: AmbientSnapshotProvider | undefined,
  enabled: boolean
): Promise<AmbientSnapshot | undefined> {
  if (!enabled || !provider) {
    return undefined;
  }
  try {
    return (await provider.snapshot()) ?? undefined;
  } catch {
    return undefined;
  }
}
