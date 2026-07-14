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

import { isRecord, stripUntrustedTerminalChars } from "@muse/shared";

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
// Hard ceiling on PARSE iterations. The render path only ever shows
// `MAX_ATTACHMENT_ENTRIES` (16); a much larger parse-time ceiling is
// generous for legitimate use (a power user with many docs pinned)
// while still bounding the per-request work for an adversarial
// metadata payload — 1M attachments → 1M sanitize calls used to be
// a viable DoS surface for any caller that accepts `metadata` from
// untrusted input (HTTP API multipart uploads).
const MAX_PARSE_ATTACHMENTS = 64;

export function parseAttachmentsFromMetadata(metadata: unknown): readonly AttachmentHint[] {
  if (!isRecord(metadata)) {
    return [];
  }
  const raw = metadata.attachments;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: AttachmentHint[] = [];
  // dedup by (name, size, mimeType). A user dragging the
  // same file twice (web upload UI, CLI `--attach a.pdf --attach a.pdf`)
  // or a buggy metadata producer that emits duplicate entries would
  // otherwise render the file twice in `[Attached Files]`, wasting
  // prompt tokens and confusing the agent. Different size or
  // different mime → different file, so the key combines all three.
  const seen = new Set<string>();
  // Hard cap on iteration. The previous loop scanned every entry in
  // the array regardless of how many would actually surface in the
  // prompt — an attacker who could write `metadata.attachments` (the
  // HTTP API path) could send 1M entries and burn one regex pass per
  // field per entry on every request.
  for (let index = 0; index < raw.length && out.length < MAX_PARSE_ATTACHMENTS; index++) {
    const entry = raw[index];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (!isRecord(entry)) continue;
    const record = entry;
    // EVERY user-supplied string gets the same inline-sanitisation
    // pass before the bound check. Sanitising only `description`
    // would leave a CRLF or `\n[System Override]\n` injection vector
    // wide open on `name` — the most prominent field of all.
    // `name` / `mimeType` / `ref` all sit on the
    // `- name · mime · size · ref=…` header line in
    // `[Attached Files]`, so a literal newline anywhere there can
    // splice a fake section into the prompt.
    const name = sanitizeAndBound(record.name, MAX_NAME_CHARS);
    if (!name) {
      continue;
    }
    const mimeType = sanitizeAndBound(record.mimeType, MAX_MIME_CHARS);
    const ref = sanitizeAndBound(record.ref, MAX_REF_CHARS);
    const description = sanitizeAndBound(record.description, MAX_DESCRIPTION_CHARS);
    const size = typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0
      ? record.size
      : undefined;
    // \x1f Unit Separator joins so a name / mime containing `:` or
    // `|` can't accidentally collide with another file's key.
    const dedupKey = `${name}\x1f${size?.toString() ?? ""}\x1f${mimeType ?? ""}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    out.push({
      ...(description ? { description } : {}),
      ...(mimeType ? { mimeType } : {}),
      name,
      ...(ref ? { ref } : {}),
      ...(size !== undefined ? { size } : {})
    });
  }
  return out;
}

/**
 * Pre-slice oversized inputs BEFORE the regex pass so a 10MB
 * malicious field doesn't burn whole-string CPU just to be
 * truncated to 256 chars afterwards. The 2x slack on the pre-slice
 * leaves room for `sanitizeInline` to collapse whitespace runs and
 * still produce a `max`-sized output.
 */
function sanitizeAndBound(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const limited = raw.length > max * 2 ? raw.slice(0, max * 2) : raw;
  return boundedString(sanitizeInline(limited), max);
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
  // inject pseudo-section headers via embedded newlines. Strip
  // ESC / C0 / C1 / DEL first — they survive the \s+ collapse and
  // would reach the prompt AND the terminal.
  return stripUntrustedTerminalChars(value).replace(/\s+/gu, " ");
}

export function renderAttachmentSection(attachments: readonly AttachmentHint[]): string | undefined {
  if (attachments.length === 0) {
    return undefined;
  }
  const lines: string[] = ["[Attached Files]"];
  lines.push("Files the user attached to this turn. Treat as primary source material when relevant.");
  const shown = attachments.slice(0, MAX_ATTACHMENT_ENTRIES);
  for (const entry of shown) {
    // render-boundary defensive sanitisation. The
    // `parseAttachmentsFromMetadata` path already strips newlines
    // at parse time, but `renderAttachmentSection` is exported and
    // external callers can hand in `AttachmentHint[]` directly
    // (third-party integration, in-process test fixture, future
    // code path). Without these guards a pre-built hint carrying
    // literal newlines would splice a fake `[System Override]`
    // section into `[Attached Files]`.
    const parts: string[] = [sanitizeInline(entry.name)];
    if (entry.mimeType) {
      parts.push(sanitizeInline(entry.mimeType));
    }
    if (entry.size !== undefined) {
      parts.push(formatSize(entry.size));
    }
    if (entry.ref) {
      parts.push(`ref=${sanitizeInline(entry.ref)}`);
    }
    const header = `- ${parts.join(" · ")}`;
    if (entry.description) {
      lines.push(`${header}\n    ${sanitizeInline(entry.description)}`);
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
