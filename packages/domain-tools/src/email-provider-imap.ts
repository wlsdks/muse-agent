/**
 * Read/send email over plain IMAP + SMTP with an app password — the
 * "no Google Cloud project" path (`muse setup email`'s recommended
 * flow). Implements the SAME `EmailProvider`/`EmailSearcher`/
 * `EmailReader`/`EmailSender` contract as `GmailEmailProvider` so every
 * existing call site (actuator tools, `muse email`, `muse inbox`, the
 * daemon email-sync tick) accepts either interchangeably.
 *
 * Each call opens a fresh IMAP/SMTP connection, does its work, and
 * closes it (no long-lived socket held by a short-running CLI process),
 * bounded by a hard timeout per the tool-loop rule
 * (`.claude/rules/architecture.md`: "Tool loops have explicit limits and
 * timeouts"). Client construction is factory-injected so tests never
 * touch a real socket — the default factories refuse to run under
 * vitest even if a test forgets to inject a fake, mirroring the
 * `isRunningUnderVitest` guard used for `launchctl`/`tailscale`/real
 * subprocess seams elsewhere in the CLI.
 */

import { ImapFlow, type FetchMessageObject, type FetchOptions, type FetchQueryObject, type MailboxObject, type MailboxOpenOptions, type MessageStructureObject, type SearchObject, type SequenceString } from "imapflow";
import { createTransport } from "nodemailer";

import type { EmailMessage, EmailProvider, EmailReader, EmailSearcher, EmailSender, EmailSummary } from "./email-provider.js";
import { isRecord, withBestEffort } from "@muse/shared";

const GMAIL_IMAP_HOST = "imap.gmail.com";
const GMAIL_IMAP_PORT = 993;
const GMAIL_SMTP_HOST = "smtp.gmail.com";
const GMAIL_SMTP_PORT = 465;
const DEFAULT_TIMEOUT_MS = 15_000;
const SNIPPET_MAX_CHARS = 200;

export interface ImapSmtpEmailProviderConfig {
  readonly email: string;
  readonly appPassword: string;
  readonly imapHost?: string;
  readonly imapPort?: number;
  readonly smtpHost?: string;
  readonly smtpPort?: number;
}

/** The narrow subset of `imapflow`'s `ImapFlow` this provider uses — a real instance satisfies it structurally, and a test injects a fake of just this shape. */
export interface ImapMailboxClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string, options?: MailboxOpenOptions): Promise<MailboxObject>;
  search(query: SearchObject, options?: { readonly uid?: boolean }): Promise<number[] | false>;
  fetch(range: SequenceString | number[] | SearchObject, query: FetchQueryObject, options?: FetchOptions): AsyncIterable<FetchMessageObject>;
  fetchOne(seq: SequenceString, query: FetchQueryObject, options?: FetchOptions): Promise<FetchMessageObject | false>;
  /** ImapFlow is an EventEmitter; without an 'error' listener a post-rejection socket timeout crashes the whole process (observed live against Gmail). Optional so contract fakes stay minimal. */
  on?(event: "error", listener: (error: unknown) => void): unknown;
  /** Hard teardown for the connect-failed path where logout() never runs. Optional for fakes. */
  close?(): void;
}

export type ImapClientFactory = (config: { readonly host: string; readonly port: number; readonly user: string; readonly pass: string }) => ImapMailboxClient;

/** The narrow subset of a `nodemailer` transporter this provider uses. */
export interface SmtpTransport {
  sendMail(options: { readonly from: string; readonly to: string; readonly subject: string; readonly text: string }): Promise<{ readonly messageId?: string }>;
  close(): void;
}

export type SmtpClientFactory = (config: { readonly host: string; readonly port: number; readonly user: string; readonly pass: string }) => SmtpTransport;

export interface ImapSmtpEmailProviderDeps {
  readonly imapClientFactory?: ImapClientFactory;
  readonly smtpClientFactory?: SmtpClientFactory;
  /** Hard bound on one connect+operate+close round trip (or one SMTP send). Default 15s. */
  readonly timeoutMs?: number;
}

/** Auth rejected by the server — the credential itself is wrong (or 2-Step Verification isn't on), never a transient condition. */
export class ImapSmtpAuthError extends Error {}

/** DNS/connect/timeout failure — worth a retry, unlike a rejected credential. */
export class ImapSmtpNetworkError extends Error {}

function isRunningUnderVitest(): boolean {
  return (process.env.VITEST ?? "").trim().length > 0 || process.env.VITEST_WORKER_ID !== undefined;
}

function defaultImapClientFactory(config: { readonly host: string; readonly port: number; readonly user: string; readonly pass: string }): ImapMailboxClient {
  if (isRunningUnderVitest()) {
    throw new Error("ImapSmtpEmailProvider: no imapClientFactory was injected under vitest — a real ImapFlow client must never be constructed in a test.");
  }
  return new ImapFlow({
    auth: { pass: config.pass, user: config.user },
    host: config.host,
    logger: false,
    port: config.port,
    secure: true
  });
}

function defaultSmtpClientFactory(config: { readonly host: string; readonly port: number; readonly user: string; readonly pass: string }): SmtpTransport {
  if (isRunningUnderVitest()) {
    throw new Error("ImapSmtpEmailProvider: no smtpClientFactory was injected under vitest — a real nodemailer transport must never be constructed in a test.");
  }
  return createTransport({
    auth: { pass: config.pass, user: config.user },
    host: config.host,
    port: config.port,
    // Implicit TLS on 465 (Gmail's SSL port); nodemailer negotiates STARTTLS
    // itself on 587 when secure is false and the server advertises it.
    secure: config.port === 465
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    const timeoutError = new ImapSmtpNetworkError(`${label} timed out after ${timeoutMs.toString()}ms`);
    timeoutHandle = setTimeout(() => {
      reject(timeoutError);
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  });
}

function redact(message: string, appPassword: string): string {
  return appPassword.trim().length > 0 ? message.split(appPassword).join("[redacted]") : message;
}

function isAuthFailure(cause: unknown): boolean {
  if (!(cause instanceof Error) || !isRecord(cause)) return false;
  if (readBooleanField(cause, "authenticationFailed") === true) return true;
  if (readStringField(cause, "code") === "EAUTH") return true;
  return /invalid credentials|authentication failed|auth\w*\s*fail/iu.test(cause.message);
}

/**
 * The server's own rejection line distinguishes causes our generic advice
 * can't: "Invalid credentials" (wrong/other-account app password) vs
 * "Please log in via your web browser" (Google security block that an app
 * password cannot pass — needs the DisplayUnlock flow). Redacted, capped.
 */
function serverRejectionDetail(cause: unknown, appPassword: string): string {
  if (!(cause instanceof Error)) return "";
  const responseText = readStringField(cause, "responseText");
  const raw = typeof responseText === "string" && responseText.trim().length > 0 ? responseText : cause.message;
  const trimmed = redact(raw, appPassword).replace(/\s+/gu, " ").trim().slice(0, 200);
  return trimmed.length > 0 ? ` Server said: "${trimmed}".` : "";
}

function webLoginBlockHint(detail: string): string {
  return /web browser|web login/iu.test(detail)
    ? " Google is blocking this sign-in (not a wrong password) — open https://accounts.google.com/DisplayUnlockCaptcha, click Continue, then retry within a few minutes."
    : "";
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function classifyImapError(cause: unknown, email: string, appPassword: string): Error {
  if (cause instanceof ImapSmtpNetworkError || cause instanceof ImapSmtpAuthError) return cause;
  if (isAuthFailure(cause)) {
    const detail = serverRejectionDetail(cause, appPassword);
    return new ImapSmtpAuthError(
      `IMAP login rejected for ${email} — check the 16-character app password (Google shows it with spaces; they must be stripped) at https://myaccount.google.com/apppasswords, confirm 2-Step Verification is on for THIS account, and make sure the app password was created on the same account.${detail}${webLoginBlockHint(detail)}`
    );
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ImapSmtpNetworkError(redact(`IMAP connection failed: ${detail}`, appPassword));
}

function classifySmtpError(cause: unknown, email: string, appPassword: string): Error {
  if (cause instanceof ImapSmtpNetworkError || cause instanceof ImapSmtpAuthError) return cause;
  if (isAuthFailure(cause)) {
    return new ImapSmtpAuthError(
      `SMTP login rejected for ${email} — check the 16-character app password (Google shows it with spaces; they must be stripped) at https://myaccount.google.com/apppasswords, and confirm 2-Step Verification is on for this account.`
    );
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ImapSmtpNetworkError(redact(`SMTP send failed: ${detail}`, appPassword));
}

function clampLimit(limit: number): number {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
}

function formatAddress(address: { readonly name?: string; readonly address?: string } | undefined): string {
  if (!address) return "";
  const email = address.address ?? "";
  return address.name && address.name.trim().length > 0 ? `${address.name} <${email}>` : email;
}

/**
 * Walk a fetched BODYSTRUCTURE for the first `text/plain` part id — the
 * root node itself when the message is single-part (imapflow's own FETCH
 * response lowercases the section name, so `"text"` — not `"1"` or
 * `"TEXT"` — is the key both the request AND the returned `bodyParts` map
 * use), else the first `text/plain` leaf across `childNodes` (breadth
 * before recursing into nested multiparts, e.g. `multipart/alternative`
 * inside `multipart/mixed`). Pure — no network, exercised directly with
 * constructed fixtures.
 */
export function findPlainTextPart(structure: MessageStructureObject | undefined): string | undefined {
  if (!structure) return undefined;
  const type = (structure.type ?? "").toLowerCase();
  if (!structure.childNodes || structure.childNodes.length === 0) {
    return type === "text/plain" || type === "" ? "text" : undefined;
  }
  for (const child of structure.childNodes) {
    if ((child.type ?? "").toLowerCase() === "text/plain" && child.part) {
      return child.part;
    }
  }
  for (const child of structure.childNodes) {
    const nested = findPlainTextPart(child);
    if (nested) return nested;
  }
  return undefined;
}

function findPartEncoding(structure: MessageStructureObject | undefined, partId: string): string | undefined {
  if (!structure) return undefined;
  if (structure.part === partId || (partId === "text" && !structure.childNodes)) return structure.encoding;
  if (!structure.childNodes) return undefined;
  for (const child of structure.childNodes) {
    const found = findPartEncoding(child, partId);
    if (found) return found;
  }
  return undefined;
}

/** RFC 2045 quoted-printable → raw bytes (soft line breaks removed, `=XX` hex-decoded). Pure. */
export function decodeQuotedPrintable(input: string): string {
  const withoutSoftBreaks = input.replace(/=\r?\n/gu, "");
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i += 1) {
    const ch = withoutSoftBreaks[i];
    const hex = ch === "=" ? withoutSoftBreaks.slice(i + 1, i + 3) : "";
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/u.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(withoutSoftBreaks.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Decode one MIME body part `Buffer` per its `Content-Transfer-Encoding`. Pure. */
export function decodeMimePart(buffer: Buffer, encoding?: string): string {
  const enc = (encoding ?? "7bit").toLowerCase();
  if (enc === "base64") {
    return Buffer.from(buffer.toString("utf8").replace(/\s+/gu, ""), "base64").toString("utf8");
  }
  if (enc === "quoted-printable") {
    return decodeQuotedPrintable(buffer.toString("latin1"));
  }
  return buffer.toString("utf8");
}

/** Collapse whitespace and cap to a short one-line preview, mirroring the Gmail-provided snippet's shape. Pure. */
export function buildSnippet(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > SNIPPET_MAX_CHARS ? `${collapsed.slice(0, SNIPPET_MAX_CHARS)}…` : collapsed;
}

/** `"from:"` / `"subject:"` prefix best-effort mapping onto IMAP SEARCH keys; anything else searches TEXT (headers + body). Pure. */
export function buildImapSearchQuery(query: string): SearchObject {
  const fromMatch = /^from:(.+)$/iu.exec(query);
  if (fromMatch?.[1]) return { from: fromMatch[1].trim() };
  const subjectMatch = /^subject:(.+)$/iu.exec(query);
  if (subjectMatch?.[1]) return { subject: subjectMatch[1].trim() };
  return { text: query };
}

export class ImapSmtpEmailProvider implements EmailProvider, EmailSearcher, EmailReader, EmailSender {
  private readonly imapHost: string;
  private readonly imapPort: number;
  private readonly smtpHost: string;
  private readonly smtpPort: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ImapSmtpEmailProviderConfig,
    private readonly deps: ImapSmtpEmailProviderDeps = {}
  ) {
    this.imapHost = config.imapHost?.trim() || GMAIL_IMAP_HOST;
    this.imapPort = config.imapPort ?? GMAIL_IMAP_PORT;
    this.smtpHost = config.smtpHost?.trim() || GMAIL_SMTP_HOST;
    this.smtpPort = config.smtpPort ?? GMAIL_SMTP_PORT;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async withMailbox<T>(fn: (client: ImapMailboxClient, mailbox: MailboxObject) => Promise<T>): Promise<T> {
    const factory = this.deps.imapClientFactory ?? defaultImapClientFactory;
    const client = factory({ host: this.imapHost, pass: this.config.appPassword, port: this.imapPort, user: this.config.email });
    // A rejected login leaves ImapFlow's socket alive; its later "Socket
    // timeout" fires as an unhandled 'error' EVENT and kills the process
    // (observed live against imap.gmail.com). Swallow — the promise chain
    // already carries the real failure.
    client.on?.("error", () => undefined);
    const run = async (): Promise<T> => {
      await client.connect();
      try {
        const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
        return await fn(client, mailbox);
      } finally {
        await withBestEffort(client.logout(), undefined);
      }
    };
    try {
      return await withTimeout(run(), this.timeoutMs, "IMAP operation");
    } catch (cause) {
      try {
        client.close?.();
      } catch { /* teardown is best-effort; the classified error below is the signal */ }
      throw classifyImapError(cause, this.config.email, this.config.appPassword);
    }
  }

  private async fetchSnippet(client: ImapMailboxClient, message: FetchMessageObject): Promise<string> {
    const partId = findPlainTextPart(message.bodyStructure);
    if (!partId) return "";
    try {
      const withPart = await client.fetchOne(message.uid, { bodyParts: [partId] }, { uid: true });
      const buffer = withPart ? withPart.bodyParts?.get(partId) : undefined;
      if (!buffer) return "";
      return buildSnippet(decodeMimePart(buffer, findPartEncoding(message.bodyStructure, partId)));
    } catch {
      // A snippet is a nice-to-have — never fail the whole listing over it.
      return "";
    }
  }

  private async toSummary(client: ImapMailboxClient, message: FetchMessageObject): Promise<EmailSummary> {
    const date = message.envelope?.date ? new Date(message.envelope.date).toISOString() : undefined;
    return {
      from: formatAddress(message.envelope?.from?.[0]),
      id: message.uid.toString(),
      snippet: await this.fetchSnippet(client, message),
      subject: message.envelope?.subject ?? "",
      unread: !(message.flags?.has("\\Seen") ?? false),
      ...(date ? { date } : {})
    };
  }

  /** The wizard's immediate-verification step: a real IMAP login + INBOX open, reporting the message count on success. Reuses `withMailbox` so a bad app password / network failure comes back through the same typed, redacted errors as every other call. */
  async verifyConnection(): Promise<{ readonly messageCount: number }> {
    return this.withMailbox(async (_client, mailbox) => ({ messageCount: mailbox.exists }));
  }

  async listRecent(limit: number): Promise<readonly EmailSummary[]> {
    const max = clampLimit(limit);
    return this.withMailbox(async (client, mailbox) => {
      if (mailbox.exists === 0) return [];
      const from = Math.max(1, mailbox.exists - max + 1);
      const summaries: EmailSummary[] = [];
      for await (const message of client.fetch(`${from.toString()}:*`, { envelope: true, flags: true, uid: true, bodyStructure: true })) {
        summaries.push(await this.toSummary(client, message));
      }
      // fetch() delivers ascending sequence (oldest→newest) — reverse for
      // newest-first, then clamp (the range can include one extra when
      // `mailbox.exists < max`).
      return summaries.reverse().slice(0, max);
    });
  }

  async search(query: string, limit: number): Promise<readonly EmailSummary[]> {
    const q = query.trim();
    if (q.length === 0) return [];
    const max = clampLimit(limit);
    return this.withMailbox(async (client) => {
      const uids = await client.search(buildImapSearchQuery(q), { uid: true });
      if (!uids || uids.length === 0) return [];
      const newestFirst = [...uids].sort((a, b) => b - a).slice(0, max);
      const summaries: EmailSummary[] = [];
      for (const uid of newestFirst) {
        const message = await client.fetchOne(uid, { envelope: true, flags: true, uid: true, bodyStructure: true }, { uid: true });
        if (message) summaries.push(await this.toSummary(client, message));
      }
      return summaries;
    });
  }

  async getMessage(id: string): Promise<EmailMessage | undefined> {
    const uid = id.trim();
    if (!/^\d+$/u.test(uid)) return undefined;
    return this.withMailbox(async (client) => {
      const message = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
      if (!message) return undefined;
      const date = message.envelope?.date ? new Date(message.envelope.date).toISOString() : undefined;
      const partId = findPlainTextPart(message.bodyStructure);
      let body = "";
      if (partId) {
        const withBody = await client.fetchOne(uid, { bodyParts: [partId] }, { uid: true });
        const buffer = withBody ? withBody.bodyParts?.get(partId) : undefined;
        if (buffer) body = decodeMimePart(buffer, findPartEncoding(message.bodyStructure, partId)).trim();
      }
      return {
        body,
        from: formatAddress(message.envelope?.from?.[0]),
        id: uid,
        subject: message.envelope?.subject ?? "",
        ...(date ? { date } : {})
      };
    });
  }

  async sendEmail(to: string, subject: string, body: string): Promise<string | undefined> {
    const factory = this.deps.smtpClientFactory ?? defaultSmtpClientFactory;
    const transport = factory({ host: this.smtpHost, pass: this.config.appPassword, port: this.smtpPort, user: this.config.email });
    try {
      const info = await withTimeout(
        transport.sendMail({ from: this.config.email, subject, text: body, to }),
        this.timeoutMs,
        "SMTP send"
      );
      return info.messageId;
    } catch (cause) {
      throw classifySmtpError(cause, this.config.email, this.config.appPassword);
    } finally {
      transport.close();
    }
  }
}
