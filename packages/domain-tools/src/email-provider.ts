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

import { fetchWithRetry, parseRetryAfterMs, type RetryOptions } from "@muse/mcp-shared";
import { isRecord, sleep } from "@muse/shared";

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

/** Search the mailbox by a query (sender / subject / keywords) — separate so a searcher depends only on what it uses. */
export interface EmailSearcher {
  search(query: string, limit: number): Promise<readonly EmailSummary[]>;
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
  if (!isRecord(payload)) {
    return "";
  }
  if (payload.mimeType === "text/plain") {
    const body = isRecord(payload.body) ? payload.body : {};
    if (typeof body.data === "string") {
      return Buffer.from(body.data, "base64url").toString("utf8");
    }
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
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
  /** Send the email; resolve to the provider's message id (proof-of-send) when available, else undefined. */
  sendEmail(to: string, subject: string, body: string): Promise<string | undefined>;
}

function header(headers: ReadonlyArray<Record<string, unknown>>, name: string): string {
  const match = headers.find((h) => typeof h.name === "string" && h.name.toLowerCase() === name.toLowerCase());
  return match && typeof match.value === "string" ? match.value : "";
}

function clampLimit(limit: number): number {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
}

function messageIds(list: Record<string, unknown>): string[] {
  if (!Array.isArray(list.messages)) {
    return [];
  }
  return list.messages.flatMap((raw) => (isRecord(raw) && typeof raw.id === "string" ? [raw.id] : []));
}

/**
 * A permanent Gmail credential failure (401/403) — token missing,
 * expired, or lacking scope. Distinct from a transient blip so the
 * inbox read can skip a single flaky message yet still surface a real
 * auth problem instead of silently returning a partial list.
 */
export class GmailAuthError extends Error {}

/**
 * Either a raw access token (env-override / test backcompat) or a function
 * that RESOLVES one per request — the seam a refreshing OAuth token source
 * (apps/cli's `createGmailTokenSource`) plugs into so `GmailEmailProvider`
 * never has to know refresh tokens or expiry exist.
 */
export type GmailAccessTokenSource = string | (() => Promise<string>);

export class GmailEmailProvider implements EmailProvider, EmailSender, EmailReader, EmailSearcher {
  constructor(
    private readonly accessTokenSource: GmailAccessTokenSource,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly retryOptions: RetryOptions = {}
  ) {}

  private async resolveAccessToken(): Promise<string> {
    return typeof this.accessTokenSource === "function"
      ? await this.accessTokenSource()
      : this.accessTokenSource;
  }

  async sendEmail(to: string, subject: string, body: string): Promise<string | undefined> {
    const mime = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=\"UTF-8\"",
      "",
      body
    ].join("\r\n");
    const raw = Buffer.from(mime, "utf8").toString("base64url");
    // A SEND is non-idempotent (Gmail has no client idempotency key), so a
    // retried POST could deliver the message TWICE. Retry ONLY a 429 rate-limit
    // — Gmail rejects it BEFORE queuing the message, so nothing was delivered —
    // honouring Retry-After. A 5xx or a network reject is AMBIGUOUS (the message
    // may have been accepted) and is NEVER retried. (Mirrors the calendar
    // actuator's safe-write retry; reads use fetchWithRetry below.)
    const retries = typeof this.retryOptions.retries === "number" && Number.isFinite(this.retryOptions.retries)
      ? Math.max(0, Math.trunc(this.retryOptions.retries))
      : 2;
    const baseDelayMs = typeof this.retryOptions.baseDelayMs === "number" && Number.isFinite(this.retryOptions.baseDelayMs)
      ? Math.max(0, this.retryOptions.baseDelayMs)
      : 250;
    const maxRetryAfterMs = typeof this.retryOptions.maxRetryAfterMs === "number" && Number.isFinite(this.retryOptions.maxRetryAfterMs)
      ? Math.max(0, this.retryOptions.maxRetryAfterMs)
      : 30_000;
    const delay = this.retryOptions.sleep ?? sleep;
    for (let attempt = 0; ; attempt += 1) {
      // Resolved every attempt (not hoisted before the loop): a retried send
      // must use the CURRENT token, not one that expired between attempts.
      const accessToken = await this.resolveAccessToken();
      const response = await this.fetchImpl(`${GMAIL_BASE}/messages/send`, {
        body: JSON.stringify({ raw }),
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        method: "POST"
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Gmail auth rejected (${response.status.toString()}) — token missing/expired or lacks gmail.send scope`);
      }
      if (response.ok) {
        // Capture Gmail's message id for proof-of-send (action-log + confirmation).
        // A successful 2xx with an odd/non-JSON body must NEVER fail the send —
        // return undefined and let the caller record the send without an id.
        try {
          const parsed = JSON.parse(await response.text());
          if (isRecord(parsed) && typeof parsed.id === "string") {
            return parsed.id;
          }
          return undefined;
        } catch {
          return undefined;
        }
      }
      if (response.status === 429 && attempt < retries) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
        await delay(retryAfterMs !== undefined ? Math.min(retryAfterMs, maxRetryAfterMs) : baseDelayMs * 2 ** attempt);
        continue;
      }
      throw new Error(`Gmail send failed (${response.status.toString()})`);
    }
  }

  private async get(url: string): Promise<Record<string, unknown>> {
    // Reads are idempotent → retry transient 429/5xx so inbox triage
    // survives a Gmail blip. sendEmail deliberately does NOT retry
    // (a retried send could deliver the message twice).
    const accessToken = await this.resolveAccessToken();
    const response = await fetchWithRetry(this.fetchImpl, url, {
      ...this.retryOptions,
      init: { headers: { authorization: `Bearer ${accessToken}` } }
    });
    if (response.status === 401 || response.status === 403) {
      throw new GmailAuthError(`Gmail auth rejected (${response.status.toString()}) — the access token is missing, expired, or lacks gmail.readonly scope`);
    }
    if (!response.ok) {
      throw new Error(`Gmail API ${response.status.toString()}`);
    }
    // Parse the 2xx body defensively: a third party CAN return a 2xx with a
    // NON-JSON body (a proxy / captive-portal / maintenance HTML page, a
    // truncated or empty body). `response.json()` would throw a raw, unwrapped
    // SyntaxError that surfaces as an opaque `muse inbox` crash — so read the
    // text and turn a malformed body into a clear, classifiable error instead.
    const body = await response.text();
    try {
      const parsed = JSON.parse(body);
      if (isRecord(parsed)) {
        return parsed;
      }
      throw new Error("non-object");
    } catch {
      throw new Error(`Gmail API returned a ${response.status.toString()} with a non-JSON body: ${body.slice(0, 200)}`);
    }
  }

  async listRecent(limit: number): Promise<readonly EmailSummary[]> {
    const max = clampLimit(limit);
    const list = await this.get(`${GMAIL_BASE}/messages?maxResults=${max.toString()}&labelIds=INBOX`);
    return this.summariesForIds(messageIds(list));
  }

  async search(query: string, limit: number): Promise<readonly EmailSummary[]> {
    const q = query.trim();
    if (q.length === 0) {
      return [];
    }
    const max = clampLimit(limit);
    const list = await this.get(`${GMAIL_BASE}/messages?maxResults=${max.toString()}&q=${encodeURIComponent(q)}`);
    return this.summariesForIds(messageIds(list));
  }

  private async summariesForIds(ids: readonly string[]): Promise<EmailSummary[]> {
    const out: EmailSummary[] = [];
    for (const id of ids) {
      const params = "format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date";
      let msg: Record<string, unknown>;
      try {
        msg = await this.get(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?${params}`);
      } catch (cause) {
        // A bad credential is permanent and affects every message — surface it.
        // A single message's transient failure / malformed body must NOT drop
        // the whole batch: skip it and return the inbox we could read.
        if (cause instanceof GmailAuthError) {
          throw cause;
        }
        continue;
      }
      const payload = isRecord(msg.payload) ? msg.payload : {};
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
    } catch (cause) {
      // A bad credential is permanent and affects every read — surface it
      // (matching listRecent), so the caller reports "re-auth" rather than
      // a misleading "message not found". A transient failure / malformed
      // body for this one message degrades to undefined.
      if (cause instanceof GmailAuthError) {
        throw cause;
      }
      return undefined;
    }
    const payload = isRecord(msg.payload) ? msg.payload : {};
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
 *
 * With `isKnownSender`, unread from people the user KNOWS (a resolved
 * contact) is surfaced FIRST and flagged "★" — a JARVIS triages the
 * inbox by who's writing, not feed order, so the named few are the
 * ones you'd actually want to reply to rather than newsletters.
 */
export function unreadBriefingLine(
  messages: readonly EmailSummary[],
  options: { readonly isKnownSender?: (from: string) => boolean } = {}
): string | undefined {
  const unread = messages.filter((m) => m.unread);
  if (unread.length === 0) {
    return undefined;
  }
  const known = options.isKnownSender;
  // V8's Array.sort is stable, so same-priority messages keep their
  // original (newest-first) order; only the known/unknown split moves.
  const ordered = known
    ? [...unread].sort((a, b) => Number(known(b.from)) - Number(known(a.from)))
    : unread;
  const named = ordered.slice(0, 3).map((m) => {
    const star = known && known(m.from) ? "★ " : "";
    return `${star}“${m.subject || "(no subject)"}” (${senderName(m.from)})`;
  });
  const more = unread.length > named.length ? `, +${(unread.length - named.length).toString()} more` : "";
  return `${unread.length.toString()} unread — ${named.join(", ")}${more}`;
}

// "Alice <a@x.com>" → "Alice"; "bob@y.com" → "bob@y.com".
function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*</u.exec(from);
  const name = match?.[1]?.trim();
  return name && name.length > 0 ? name : (from.trim() || "unknown");
}

/**
 * Pull the bare email address out of a `From` header — "Alice
 * <a@x.com>" → "a@x.com", "bob@y.com" → "bob@y.com" — lowercased, or
 * `undefined` when none is present. Lets a caller match an unread
 * sender against the contacts graph.
 */
export function extractEmailAddress(from: string): string | undefined {
  const angled = /<([^>]+)>/u.exec(from);
  const candidate = angled?.[1] ?? from;
  const addr = /([^\s<>]+@[^\s<>]+)/u.exec(candidate);
  return addr?.[1]?.trim().toLowerCase();
}
