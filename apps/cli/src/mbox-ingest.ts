/**
 * `.mbox` mail → markdown notes, for `muse ingest`. Email is the
 * privacy-bound beachhead's biggest "I know I wrote it somewhere" corpus, and
 * it's exactly the data they'd never paste into a cloud assistant. This is a
 * LEAN, dependency-free, best-effort parser: it splits the mbox, reads the
 * key headers (From/To/Subject/Date), and extracts the plaintext body
 * (quoted-printable / base64 decoded, simple multipart text part picked, HTML
 * tag-stripped). It deliberately skips attachments and deep nested MIME — the
 * goal is searchable, citable text, not a faithful mail client. Each message
 * becomes one note the existing reindex + cited-recall pipeline picks up.
 */

import type { IngestedConversation } from "./chat-export-ingest.js";
import { slugifyTitle } from "./chat-export-ingest.js";

/** True when the raw text looks like an mbox (starts with a "From " separator line). */
export function looksLikeMbox(raw: string): boolean {
  return /^From .+(\r?\n|$)/u.test(raw.replace(/^\uFEFF/u, ""));
}

/**
 * Split an mbox into raw message blocks. The mbox separator is a line that
 * starts with "From " at the START of a message (file start, or after a blank
 * line) — this avoids splitting on a "From " that merely appears inside a body.
 */
export function splitMboxMessages(raw: string): readonly string[] {
  const lines = raw.replace(/^\uFEFF/u, "").split(/\r?\n/);
  const messages: string[] = [];
  let current: string[] | undefined;
  let prevBlank = true; // file start counts as "after a blank line"
  for (const line of lines) {
    if (/^From .+/u.test(line) && prevBlank) {
      if (current && current.join("\n").trim().length > 0) messages.push(current.join("\n"));
      current = [];
    } else {
      (current ??= []).push(line);
    }
    prevBlank = line.trim().length === 0;
  }
  if (current && current.join("\n").trim().length > 0) messages.push(current.join("\n"));
  return messages;
}

interface ParsedHeaders {
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

/** Split a message into unfolded headers + body. Header names are lowercased. */
export function parseHeaders(rawMessage: string): ParsedHeaders {
  const lines = rawMessage.split(/\r?\n/);
  const headers = new Map<string, string>();
  let i = 0;
  let lastKey: string | undefined;
  for (; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim().length === 0) { i += 1; break; } // blank line ends headers
    if (/^[ \t]/u.test(line) && lastKey) {
      headers.set(lastKey, `${headers.get(lastKey) ?? ""} ${line.trim()}`); // folded continuation
      continue;
    }
    const m = /^([!-9;-~]+):\s?(.*)$/u.exec(line); // header-name: value
    if (m) {
      lastKey = m[1]!.toLowerCase();
      headers.set(lastKey, m[2] ?? "");
    }
  }
  return { body: lines.slice(i).join("\n"), headers };
}

function decodeQuotedPrintable(text: string): string {
  const noSoftBreaks = text.replace(/=\r?\n/gu, "");
  const bytes: number[] = [];
  for (let i = 0; i < noSoftBreaks.length;) {
    if (noSoftBreaks[i] === "=" && /^[0-9A-Fa-f]{2}$/u.test(noSoftBreaks.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(noSoftBreaks.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      for (const b of Buffer.from(noSoftBreaks[i]!, "utf8")) bytes.push(b);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeBase64(text: string): string {
  try {
    return Buffer.from(text.replace(/\s+/gu, ""), "base64").toString("utf8");
  } catch {
    return text;
  }
}

/** Strip HTML to readable text: drop script/style, tags → space, decode a few entities. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">").replace(/&quot;/giu, "\"").replace(/&#39;/giu, "'")
    .replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
}

function decodePart(body: string, contentType: string, cte: string): string {
  let decoded = body;
  if (/quoted-printable/iu.test(cte)) decoded = decodeQuotedPrintable(body);
  else if (/base64/iu.test(cte)) decoded = decodeBase64(body);
  if (/text\/html/iu.test(contentType)) decoded = stripHtml(decoded);
  return decoded;
}

/**
 * Best-effort body extraction. Multipart → pick the first text/plain part
 * (else the first text/html, stripped); single part → decode per its CTE.
 * One level of multipart is handled; nested/attachment parts are skipped.
 */
export function extractBody(parsed: ParsedHeaders): string {
  const contentType = parsed.headers.get("content-type") ?? "";
  const cte = parsed.headers.get("content-transfer-encoding") ?? "";
  const boundaryMatch = /boundary="?([^";\r\n]+)"?/iu.exec(contentType);
  if (/multipart\//iu.test(contentType) && boundaryMatch) {
    const boundary = boundaryMatch[1]!;
    const rawParts = parsed.body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:--)?`, "u"));
    const parts = rawParts.map((p) => parseHeaders(p.replace(/^\r?\n/u, "")));
    const plain = parts.find((p) => /text\/plain/iu.test(p.headers.get("content-type") ?? ""));
    const html = parts.find((p) => /text\/html/iu.test(p.headers.get("content-type") ?? ""));
    const chosen = plain ?? html;
    if (chosen) {
      return decodePart(chosen.body, chosen.headers.get("content-type") ?? "", chosen.headers.get("content-transfer-encoding") ?? "").trim();
    }
  }
  return decodePart(parsed.body, contentType, cte).trim();
}

/** Decode RFC-2047 encoded-words in a header value (Subject etc.), best-effort. */
export function decodeHeaderValue(value: string): string {
  return value.replace(/=\?[^?]+\?([bBqQ])\?([^?]*)\?=/gu, (_m, enc: string, data: string) => {
    if (enc.toLowerCase() === "b") return decodeBase64(data);
    return decodeQuotedPrintable(data.replace(/_/gu, " "));
  }).trim();
}

export function ingestMbox(raw: string): readonly IngestedConversation[] {
  const out: IngestedConversation[] = [];
  splitMboxMessages(raw).forEach((rawMsg, index) => {
    const parsed = parseHeaders(rawMsg);
    const subject = decodeHeaderValue(parsed.headers.get("subject") ?? "").trim() || `Email ${(index + 1).toString()}`;
    const from = decodeHeaderValue(parsed.headers.get("from") ?? "").trim();
    const to = decodeHeaderValue(parsed.headers.get("to") ?? "").trim();
    const date = (parsed.headers.get("date") ?? "").trim();
    const body = extractBody(parsed);
    if (body.length === 0 && from.length === 0) return; // nothing usable
    const metaBits = [from && `From: ${from}`, to && `To: ${to}`, date && date].filter((b): b is string => Boolean(b));
    const markdown = `# ${subject}\n\n_Email${metaBits.length ? ` — ${metaBits.join(" · ")}` : ""}_\n\n${body}\n`;
    const createdIso = ((): string | undefined => {
      const t = Date.parse(date);
      return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
    })();
    out.push({ ...(createdIso ? { createdIso } : {}), markdown, slug: slugifyTitle(subject, `email-${(index + 1).toString()}`), title: subject });
  });
  // De-collide slugs (many emails share a subject like "Re: lunch").
  const seen = new Map<string, number>();
  return out.map((c) => {
    const n = (seen.get(c.slug) ?? 0) + 1;
    seen.set(c.slug, n);
    return n === 1 ? c : { ...c, slug: `${c.slug}-${n.toString()}` };
  });
}
