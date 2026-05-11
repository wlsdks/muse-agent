/**
 * Attachment-context surface (D10).
 *
 * Personal-assistant front-ends (web upload, CLI file pin, voice
 * mode screenshot) declare attachments via
 * `AgentRunInput.metadata.attachments` — a JSON-friendly array of
 * `{ name, mimeType?, size?, description?, ref? }`. The runtime
 * surfaces them as an `[Attached Files]` block in the system
 * prompt so the agent can plan around them without first calling a
 * file tool. Actual binary upload to a vision-capable provider
 * (Gemini inline data, OpenAI image_url) is a separate adapter
 * concern — this surface is text-only on purpose so it works
 * across every provider.
 */

import type { AgentRunContext, AgentRunInput } from "./types.js";
import { appendSystemSection } from "./runtime-helpers.js";

export interface AttachmentHint {
  readonly name: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly description?: string;
  /** Opaque reference id (e.g. ContextReferenceStore id) for tools that expand on demand. */
  readonly ref?: string;
}

// Per-field length caps. The metadata is user-supplied (web upload
// form, CLI file pin, voice screenshot) so an overlong or
// adversarial value must not blow the system prompt or break the
// `[Attached Files]` block layout. The caps are deliberately
// generous for normal use and sharp enough to bound the worst case.
const MAX_NAME_CHARS = 256;
const MAX_MIME_CHARS = 128;
const MAX_REF_CHARS = 256;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_ATTACHMENT_ENTRIES = 16;

export function parseAttachmentsFromMetadata(metadata: unknown): readonly AttachmentHint[] {
  if (!metadata || typeof metadata !== "object") {
    return [];
  }
  const raw = (metadata as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: AttachmentHint[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    // EVERY user-supplied string gets the same inline-sanitisation
    // pass before the bound check. Round 1 (iter 4) only sanitised
    // `description`, which left a CRLF or `\n[System Override]\n`
    // injection vector wide open on `name` — the most prominent
    // field of all. `name` / `mimeType` / `ref` all sit on the
    // `- name · mime · size · ref=…` header line in
    // `[Attached Files]`, so a literal newline anywhere there can
    // splice a fake section into the prompt.
    const name = boundedString(
      typeof record.name === "string" ? sanitizeInline(record.name) : undefined,
      MAX_NAME_CHARS
    );
    if (!name) {
      continue;
    }
    const mimeType = boundedString(
      typeof record.mimeType === "string" ? sanitizeInline(record.mimeType) : undefined,
      MAX_MIME_CHARS
    );
    const ref = boundedString(
      typeof record.ref === "string" ? sanitizeInline(record.ref) : undefined,
      MAX_REF_CHARS
    );
    const description = boundedString(
      typeof record.description === "string" ? sanitizeInline(record.description) : undefined,
      MAX_DESCRIPTION_CHARS
    );
    out.push({
      ...(description ? { description } : {}),
      ...(mimeType ? { mimeType } : {}),
      name,
      ...(ref ? { ref } : {}),
      ...(typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0
        ? { size: record.size }
        : {})
    });
  }
  return out;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function sanitizeInline(value: string): string {
  // Collapse any whitespace run (\n, \r, \t, multiple spaces) to a
  // single space so descriptions render on one line and cannot
  // inject pseudo-section headers via embedded newlines.
  return value.replace(/\s+/gu, " ");
}

export function renderAttachmentSection(attachments: readonly AttachmentHint[]): string | undefined {
  if (attachments.length === 0) {
    return undefined;
  }
  const lines: string[] = ["[Attached Files]"];
  lines.push("Files the user attached to this turn. Treat as primary source material when relevant.");
  const shown = attachments.slice(0, MAX_ATTACHMENT_ENTRIES);
  for (const entry of shown) {
    const parts: string[] = [entry.name];
    if (entry.mimeType) {
      parts.push(entry.mimeType);
    }
    if (entry.size !== undefined) {
      parts.push(formatSize(entry.size));
    }
    if (entry.ref) {
      parts.push(`ref=${entry.ref}`);
    }
    const header = `- ${parts.join(" · ")}`;
    if (entry.description) {
      lines.push(`${header}\n    ${entry.description}`);
    } else {
      lines.push(header);
    }
  }
  if (attachments.length > shown.length) {
    lines.push(`…and ${(attachments.length - shown.length).toString()} more attachment(s) not shown.`);
  }
  return lines.join("\n");
}

export function applyAttachmentContext(context: AgentRunContext): AgentRunInput {
  const attachments = parseAttachmentsFromMetadata(context.input.metadata);
  const rendered = renderAttachmentSection(attachments);
  if (!rendered) {
    return context.input;
  }
  return {
    ...context.input,
    messages: appendSystemSection(context.input.messages, rendered, "attachment-context"),
    metadata: {
      ...context.input.metadata,
      attachmentContextApplied: true,
      attachmentContextCount: attachments.length
    }
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}
