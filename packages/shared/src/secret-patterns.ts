/**
 * High-confidence secret-shape + labeled-credential patterns. Each entry
 * names the family + the regex that catches the bytes. Two consumers share
 * this ONE list so they can never diverge into two different notions of
 * "looks like a secret":
 *
 *   - `redactSecretsInText` (index.ts) — MASKS a match in text that is about
 *     to be logged / relayed (proactive notices, error messages, history).
 *   - `guardSecretPersistence` (secret-persistence-guard.ts) — REFUSES a
 *     write outright when a persistence tool's content matches.
 *
 * The patterns lean toward "stable prefix + entropy length". A false
 * positive on a regular sentence is much less harmful than a false negative
 * on a real credential, but we still prefer recognisable upstream-issued
 * shapes over generic "long random string" heuristics.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly regex: RegExp }> = [
  // PEM-encoded private keys (RSA, DSA, EC, OPENSSH, ENCRYPTED,
  // bare PKCS#8, PGP "...PRIVATE KEY BLOCK..."). Runs FIRST so
  // the entire ASCII-armored frame is redacted as one unit
  // before a sub-pattern (jwt, openai-key, etc.) can nibble the
  // base64 body. Catastrophic-backtrack safe: bounded optional
  // algorithm prefix + optional " BLOCK" suffix + lazy body match.
  { name: "private-key", regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/gu },
  // `<scheme>://[user]:password@host` — DB / cache / broker
  // connection URIs with an inline password. Runs FIRST so the
  // whole credentialed URI is redacted as one unit before a
  // sub-pattern can nibble (e.g. a JWT-shaped password). A
  // credential-free `https://host` lacks `:pass@` and is left
  // intact. Sibling of the migration-redaction connection rule.
  { name: "connection-uri", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:[^\s/?#@]+@[^\s)"'<>]+/giu },
  // A secret carried as a URL query-parameter VALUE (presigned S3
  // `?X-Amz-Signature=…`, `?api_key=…`, `?access_token=…`, a generic
  // `?token=…`). These leak into logs / proactive notices / tool output
  // even when the value isn't a recognised vendor shape, so match by the
  // sensitive KEY and redact whatever value follows. Variable-length
  // lookbehind keeps the `key=` prefix (V8 supports it); the value class
  // is a simple negated set, so no catastrophic backtracking.
  {
    name: "url-credential",
    regex: /(?<=[?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|authorization|auth|password|passwd|pwd|secret|signature|sig|token|x-amz-(?:signature|credential|security-token))=)[^&\s#"'<>]+/giu
  },
  // Order matters: the more-specific Anthropic / OpenAI-project
  // prefixes must run before the generic `sk-` so a token like
  // `sk-ant-api03-...` lands in the right bucket.
  { name: "anthropic-key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/gu },
  { name: "openai-key", regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu },
  { name: "github-pat", regex: /gh[pousr]_[A-Za-z0-9_]{30,}/gu },
  // Fine-grained PATs are `github_pat_…`, which the classic
  // `gh[pousr]_` shape above cannot match — it's now GitHub's
  // default token format, so a separate pattern is required.
  { name: "github-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/gu },
  { name: "aws-access-key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35,}/gu },
  // Google OAuth 2.0 access token — `ya29.` + a long entropy body.
  // A real bearer credential (Gmail / Calendar / Drive scopes) that
  // can land in a pasted curl command or chat message.
  { name: "google-oauth-token", regex: /\bya29\.[A-Za-z0-9_-]{20,}/gu },
  { name: "slack-bot-token", regex: /xox[abprs]-[A-Za-z0-9-]{10,}/gu },
  // Publishable pk_* keys are deliberately NOT redacted — they
  // ship in client code by design.
  { name: "stripe-secret", regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/gu },
  // Only the modern glpat- shape; legacy GitLab tokens are too
  // low-entropy to redact without false positives.
  { name: "gitlab-pat", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/gu },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu },
  // Muse's own delivery channels: a leaked bot token round-trips
  // via the very channel it controls (the docstring's threat
  // model). Telegram: `<botId 6+ digits>:<exactly 35 base64url>`
  // — distinctive enough to redact without false positives.
  { name: "telegram-bot-token", regex: /\b\d{6,}:[A-Za-z0-9_-]{35}\b/gu },
  // Discord bot token: three base64url segments, NOT `eyJ`-prefixed
  // (the jwt rule above runs first and rewrites real JWTs, so this
  // only ever sees genuine non-JWT triple-segment tokens).
  { name: "discord-bot-token", regex: /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,8}\.[A-Za-z0-9_-]{27,}\b/gu },
  // A generic HTTP `Authorization: Bearer <token>` credential — not tied to
  // a vendor prefix, so it's caught by the "Bearer" keyword instead. 16+
  // chars of token-alphabet after the keyword to avoid matching a stray
  // "Bearer of good news" sentence (which has no token-shaped tail).
  { name: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/giu },
  // An explicit password/passphrase/token LABEL directly bound to a value —
  // "내 비밀번호 hunter2를 저장해줘", "password: abc123", "api key = sk-…".
  // The value must immediately follow the label (no wildcard skip), so a
  // sentence that merely DISCUSSES the label ("비밀번호 정책", "password
  // reset", "비밀번호 바꾸는 법") never matches: those continuation words are
  // either Korean (excluded — the value class is ASCII-only) or short
  // English words that satisfy neither branch below. A real value either
  // contains a digit (any length ≥3, e.g. "hunter2") or is a longer
  // (≥8 char) pure-letter token (a plausible dictionary-word password).
  // A letter-adjacency guard (NOT `\b`, which treats `_`/digits as word
  // chars) brackets ONLY the English alternatives — a LETTER on either side
  // disqualifies the match (blocks "realSecret1234", "secretary", "mypassword"),
  // but a non-letter separator (`_`, space, `-`, digit, start/end of string)
  // does not — so a structured field name like "wifi_password" still counts
  // as a label (remember_fact's `key`/`value` are separate params the guard
  // recombines as "<key> <value>"). Hangul isn't a JS `\w`/letter char either
  // way, so the Korean alternatives need no such guard.
];

export interface SecretMatch {
  readonly kind: string;
  readonly value: string;
}

/**
 * Scan `text` against every pattern above and return each match (kind +
 * matched substring), WITHOUT mutating it — the non-destructive sibling of
 * `redactSecretsInText`. `matchAll` on a `g`-flagged regex creates its own
 * iterator state per the spec, so calling this repeatedly across the
 * module-level `SECRET_PATTERNS` regexes never leaks stale `lastIndex`.
 */
export function findSecrets(text: string): readonly SecretMatch[] {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }
  const found: SecretMatch[] = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      found.push({ kind: name, value: match[0] });
    }
  }
  return found;
}

/**
 * Patterns used ONLY by the persistence guard, never by `redactSecretsInText`
 * (the masker must stay high-precision — it rewrites persisted memory/history).
 * A label followed by a value that is NOT a plain English word: the value must
 * carry a digit or symbol, or be a vendor-shaped token. This is why
 * "the secret ingredient is patience" / "reset my password tomorrow" do NOT
 * match, but "비밀번호는 hunter2" / "password: p@ss!" do.
 */
export const GUARD_ONLY_PATTERNS: ReadonlyArray<{ readonly name: string; readonly regex: RegExp }> = [
  {
    name: "credential-label",
    regex: /(?:(?<![A-Za-z])(?:password|passphrase|api[ _-]?key|secret|token)(?![A-Za-z])|비밀번호|암호|패스워드|비번|토큰|시크릿)\s*(?:은|는|이|가|을|를)?\s*(?:is|are|[:=])?\s*["'`]?((?=[A-Za-z0-9!@#$%^&*()_+./-]*[\d!@#$%^&*()_+./])[A-Za-z0-9!@#$%^&*()_+./-]{3,})["'`]?/giu
  }
];

/** Guard-side scan: the shared masker patterns PLUS the guard-only ones. */
export function findSecretsForGuard(text: string): readonly SecretMatch[] {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }
  const found: SecretMatch[] = [...findSecrets(text)];
  for (const { name, regex } of GUARD_ONLY_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      found.push({ kind: name, value: match[0] });
    }
  }
  return found;
}
