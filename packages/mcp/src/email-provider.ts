/**
 * Read-only email ingest behind a model-neutral abstraction (the way
 * calendar / weather did). `GmailEmailProvider` reads the inbox over
 * the Gmail REST API (HTTP, Bearer access token) — no SDK, no new dep.
 *
 * READ ONLY. Reading the inbox is world-sensing, so no outbound-safety
 * gate applies (`.claude/rules/outbound-safety.md` governs only
 * actions toward a third party). Sending / replying is a separate,
 * draft-first + gated capability and lives elsewhere.
 *
 * Lives in @muse/mcp so both the CLI (`muse inbox`) and the proactive
 * briefing daemon (needs-reply surfacing) can reuse it.
 */

import { fetchWithRetry, type RetryOptions } from "./http-retry.js";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface EmailSummary {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly snippet: string;
  readonly date?: string;
  readonly unread: boolean;
}

export interface EmailMessage {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly date?: string;
  /** Plain-text body (extracted from the MIME payload; snippet fallback). */
  readonly body: string;
}

export interface EmailProvider {
  /** Most-recent inbox messages, newest first (provider order). */
  listRecent(limit: number): Promise<readonly EmailSummary[]>;
}

/** Read one message's full body — separate so a reader depends only on what it uses. */
export interface EmailReader {
  getMessage(id: string): Promise<EmailMessage | undefined>;
}

/**
 * Pull the plain-text body out of a Gmail message payload: a direct
 * `text/plain` body, else the first `text/plain` part (recursing into
 * multipart). Returns "" when there's no plain-text part (the caller
 * falls back to the snippet). Pure — no network.
 */
export function extractPlainTextBody(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const p = payload as { mimeType?: unknown; body?: { data?: unknown }; parts?: unknown };
  if (p.mimeType === "text/plain" && typeof p.body?.data === "string") {
    return Buffer.from(p.body.data, "base64url").toString("utf8");
  }
  if (Array.isArray(p.parts)) {
    for (const part of p.parts) {
      const text = extractPlainTextBody(part);
      if (text.length > 0) {
        return text;
      }
    }
  }
  return "";
}

/**
 * Outbound send, kept a separate interface so a read-only provider /
 * the gated-send orchestration depend only on what they use. The
 * actual send is ALWAYS gated upstream by `sendEmailWithApproval` —
 * this is just the transport.
 */
export interface EmailSender {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

function header(headers: ReadonlyArray<Record<string, unknown>>, name: string): string {
  const match = headers.find((h) => typeof h.name === "string" && h.name.toLowerCase() === name.toLowerCase());
  return match && typeof match.value === "string" ? match.value : "";
}

export class GmailEmailProvider implements EmailProvider, EmailSender, EmailReader {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly retryOptions: RetryOptions = {}
  ) {}

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    const mime = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=\"UTF-8\"",
      "",
      body
    ].join("\r\n");
    const raw = Buffer.from(mime, "utf8").toString("base64url");
    const response = await this.fetchImpl(`${GMAIL_BASE}/messages/send`, {
      body: JSON.stringify({ raw }),
      headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json" },
      method: "POST"
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Gmail auth rejected (${response.status.toString()}) — token missing/expired or lacks gmail.send scope`);
    }
    if (!response.ok) {
      throw new Error(`Gmail send failed (${response.status.toString()})`);
    }
  }

  private async get(url: string): Promise<Record<string, unknown>> {
    // Reads are idempotent → retry transient 429/5xx so inbox triage
    // survives a Gmail blip. sendEmail deliberately does NOT retry
    // (a retried send could deliver the message twice).
    const response = await fetchWithRetry(this.fetchImpl, url, {
      ...this.retryOptions,
      init: { headers: { authorization: `Bearer ${this.accessToken}` } }
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Gmail auth rejected (${response.status.toString()}) — the access token is missing, expired, or lacks gmail.readonly scope`);
    }
    if (!response.ok) {
      throw new Error(`Gmail API ${response.status.toString()}`);
    }
    return await response.json() as Record<string, unknown>;
  }

  async listRecent(limit: number): Promise<readonly EmailSummary[]> {
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
    const list = await this.get(`${GMAIL_BASE}/messages?maxResults=${max.toString()}&labelIds=INBOX`);
    const ids = Array.isArray(list.messages)
      ? (list.messages as Array<Record<string, unknown>>).flatMap((m) => (typeof m.id === "string" ? [m.id] : []))
      : [];
    const out: EmailSummary[] = [];
    for (const id of ids) {
      const params = "format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date";
      const msg = await this.get(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?${params}`);
      const payload = (msg.payload ?? {}) as { headers?: ReadonlyArray<Record<string, unknown>> };
      const headers = Array.isArray(payload.headers) ? payload.headers : [];
      const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds : [];
      const dateHeader = header(headers, "Date");
      out.push({
        from: header(headers, "From"),
        id,
        snippet: typeof msg.snippet === "string" ? msg.snippet : "",
        subject: header(headers, "Subject"),
        unread: labelIds.includes("UNREAD"),
        ...(dateHeader ? { date: dateHeader } : {})
      });
    }
    return out;
  }

  async getMessage(id: string): Promise<EmailMessage | undefined> {
    if (!id || id.trim().length === 0) {
      return undefined;
    }
    let msg: Record<string, unknown>;
    try {
      msg = await this.get(`${GMAIL_BASE}/messages/${encodeURIComponent(id.trim())}?format=full`);
    } catch {
      return undefined;
    }
    const payload = (msg.payload ?? {}) as { headers?: ReadonlyArray<Record<string, unknown>> };
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    const dateHeader = header(headers, "Date");
    const body = extractPlainTextBody(payload) || (typeof msg.snippet === "string" ? msg.snippet : "");
    return {
      body,
      from: header(headers, "From"),
      id: id.trim(),
      subject: header(headers, "Subject"),
      ...(dateHeader ? { date: dateHeader } : {})
    };
  }
}

/**
 * One-line triage summary of an inbox snapshot — "12 messages, 3
 * unread" — plus the unread subjects. Pure so the CLI / briefing can
 * render it and a test can pin it without HTTP.
 */
export function summarizeInbox(messages: readonly EmailSummary[]): string {
  const unread = messages.filter((m) => m.unread);
  if (messages.length === 0) {
    return "Inbox empty.";
  }
  const head = `${messages.length.toString()} message${messages.length === 1 ? "" : "s"}, ${unread.length.toString()} unread`;
  if (unread.length === 0) {
    return `${head}.`;
  }
  const subjects = unread.slice(0, 5).map((m) => `“${m.subject || "(no subject)"}” — ${m.from || "(unknown)"}`);
  return `${head}. Unread:\n${subjects.map((s) => `  - ${s}`).join("\n")}`;
}

/**
 * Compact one-line unread digest for the proactive briefing, or
 * `undefined` when nothing is unread (so the briefing stays quiet
 * about a clean inbox). Names a few unread subjects so the brief is
 * actionable ("reply to X"), not just a count.
 */
export function unreadBriefingLine(messages: readonly EmailSummary[]): string | undefined {
  const unread = messages.filter((m) => m.unread);
  if (unread.length === 0) {
    return undefined;
  }
  const named = unread.slice(0, 3).map((m) => `“${m.subject || "(no subject)"}” (${senderName(m.from)})`);
  const more = unread.length > named.length ? `, +${(unread.length - named.length).toString()} more` : "";
  return `${unread.length.toString()} unread — ${named.join(", ")}${more}`;
}

// "Alice <a@x.com>" → "Alice"; "bob@y.com" → "bob@y.com".
function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*</u.exec(from);
  const name = match?.[1]?.trim();
  return name && name.length > 0 ? name : (from.trim() || "unknown");
}
