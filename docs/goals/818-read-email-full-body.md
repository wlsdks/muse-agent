# 818 — feat: read a specific email's full body (`read_email`)

## Why

`email_recent` (808) returned only the snippet, so "read me Jane's full
email" was unanswerable — and it didn't even surface the message id the
model would need to fetch one. This adds full-body read, completing
inbox triage → open.

## Slice

- `@muse/mcp` email-provider.ts — `extractPlainTextBody(payload)` (pure:
  a direct `text/plain` body, else the first `text/plain` part,
  recursing multipart, ignoring `text/html`; "" when none) +
  `GmailEmailProvider.getMessage(id)` (`format=full` via the
  retry-hardened `get`, headers + body, snippet fallback; `undefined`
  on any failure — never throws). New `EmailReader` interface +
  `EmailMessage` type.
- email-tool.ts — `email_recent` now includes each message's `id`;
  new `read_email` tool (risk:read, param `id`) over the reader.
- `@muse/autoconfigure` — `read_email` registered alongside
  `email_recent` (same `MUSE_GMAIL_TOKEN` gate, same provider).

## Verify

- `@muse/mcp` email-read-message.test.ts (new, 6, contract-faithful
  Gmail full-message fake): `extractPlainTextBody` reads a direct
  text/plain body, prefers the text/plain part over text/html, returns
  "" with no plain part; `getMessage` returns parsed body+headers and
  `undefined` on a 404; the `read_email` tool is risk:read, returns the
  body, `found:false` for empty id.
- `@muse/autoconfigure` email-read-wiring.test.ts (+1): the REAL
  assembly exposes `read_email` (risk:read) gated on the Gmail token;
  absent without it.
- **Mutation-proven**: dropping the `text/plain` mimeType check in
  `extractPlainTextBody` → it returns the HTML part → 2 tests fail;
  restore → 6/6. Full `pnpm check` EXIT 0, `pnpm lint` 0/0. Tool
  catalog rides the model request → live SELECTION wants `smoke:live`;
  Ollama down → deferred.

## Decisions

- **Plain-text only, snippet fallback** — a personal assistant reads
  the text body; HTML is skipped (no DOM strip) and an HTML-only mail
  falls back to the Gmail snippet rather than dumping markup. The pure
  extractor is the mutation-proven core.
- **Reuses the retry-hardened `get`** — `getMessage` inherits 761's
  429/5xx retry; a failure degrades to `undefined` so the tool reports
  not-found. No bullet flip — completes the email read pair (recent →
  full). CAPABILITIES line under P20.
