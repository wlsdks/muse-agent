import { stripUntrustedTerminalChars } from "@muse/shared";

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

function sanitizeInline(value: string): string {
  return stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim();
}

export function renderAmbientContextSection(snapshot: AmbientSnapshot | undefined): string | undefined {
  if (!snapshot) {
    return undefined;
  }
  const fields: [string, string | undefined][] = [
    ["app", snapshot.app],
    ["window", snapshot.window],
    ["selected", snapshot.selected],
    ["clipboard", snapshot.clipboard],
    ["notifications", snapshot.notifications]
  ];
  const lines = ["[Ambient Context]"];
  for (const [key, raw] of fields) {
    if (raw === undefined) continue;
    const value = sanitizeInline(raw);
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
