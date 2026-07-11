// Pure detection logic for check-secret-guard-coverage.mjs — split out so
// scripts/check-secret-guard-coverage.test.mjs can feed it synthetic fixture
// strings without touching the filesystem.

/**
 * Free-text-shaped arg names a persistence tool reads and writes verbatim to
 * a store — the exact fields that carried a fabricated/user-typed secret in
 * every instance of this bug class so far (identity notes, false-action
 * notes, secret-notes, secret-registry, calendar, contacts, followups).
 * Deliberately NOT "id" / "providerId" / "dueAt" / booleans / enums — those
 * are structured, not user-authored prose, and guarding them would just be
 * noise on every list/delete/complete tool.
 */
export const FREE_TEXT_FIELD_NAMES = [
  "title", "notes", "content", "body", "text", "location", "value", "key", "relationship", "reason"
];

const FREE_TEXT_FIELD_PATTERN = new RegExp(
  `readString\\(args,\\s*["'](?:${FREE_TEXT_FIELD_NAMES.join("|")})["']\\)`,
  "u"
);
const GUARD_CALL_PATTERN = /\b(assertNoSecretInPersistedFields|guardSecretPersistence)\s*\(/u;
const RISK_WRITE_PATTERN = /risk:\s*["']write["']/u;
const EXECUTE_PATTERN = /execute:\s*async\s*\(/gu;
const NAME_FIELD_PATTERN = /\bname:\s*"([a-zA-Z0-9_-]+)"/gu;

/**
 * Split a domain-tools source file into per-tool segments. Tool object
 * literals in this codebase consistently order their fields
 * `execute → inputSchema → domain/keywords → name → risk`, so the text from
 * one `execute:` occurrence up to (not including) the next IS that tool's
 * own execute body plus its trailing metadata (including `risk`) — exactly
 * the scope this check needs. A file with exactly one `execute:` occurrence
 * (a single-tool file, e.g. remember-fact-tool.ts, where `risk` sits in an
 * earlier `definition: {...}` block) uses the WHOLE file as its one segment
 * instead, so that earlier `risk` field is still in scope.
 */
export function splitIntoToolSegments(content) {
  const matches = [...content.matchAll(EXECUTE_PATTERN)];
  if (matches.length === 0) {
    return [];
  }
  if (matches.length === 1) {
    return [content];
  }
  const segments = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    segments.push(content.slice(start, end));
  }
  return segments;
}

function lastToolName(segment) {
  const names = [...segment.matchAll(NAME_FIELD_PATTERN)].map((m) => m[1]);
  return names.length > 0 ? names[names.length - 1] : "(unnamed tool)";
}

/**
 * Analyze one file's content and return a violation for every tool segment
 * that is `risk: "write"`, reads a free-text field, and never calls the
 * shared secret-persistence guard anywhere in its own segment.
 */
export function findViolations(relPath, content) {
  const violations = [];
  for (const segment of splitIntoToolSegments(content)) {
    if (!RISK_WRITE_PATTERN.test(segment)) continue;
    if (!FREE_TEXT_FIELD_PATTERN.test(segment)) continue;
    if (GUARD_CALL_PATTERN.test(segment)) continue;
    violations.push({ file: relPath, tool: lastToolName(segment) });
  }
  return violations;
}
