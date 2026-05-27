# 496 — direct coverage for `stripUntrustedTerminalChars` (test-only; 458/477/479/480/485/487/491/492 class)

## Why

`stripUntrustedTerminalChars` (`@muse/shared` `index.ts:106`) is
the **single canonical terminal-safety sanitizer** every Muse
surface uses when it hands publisher- / tool- / user-supplied
text to stdout or persistence: feeds (471), `muse glance`
(089), inbox / messaging providers, search results, model
deltas, RAG citations, calendar import (467), etc. Its regex
range — `[\x00-\x08\x0b-\x1f\x7f-\x9f]` — strips:

- the C0 control range minus the two whitelisted controls
  (newline `\x0a`, tab `\x09`),
- DEL (`\x7f`),
- the C1 high-set (`\x80-\x9f`, including bare 8-bit CSI
  `\x9b`).

The function had **no direct test** in `@muse/shared`. Every
downstream surface tests its OWN consumption of the helper but
the helper's own contract (which characters are stripped, which
are preserved) was implicit-only. A future "simplification" PR
that trimmed the regex to `[\x00-\x08\x0b-\x1f]` — dropping the
DEL + C1 ranges — would leave every consuming surface vulnerable
to 8-bit CSI / DEL terminal-state injection, with no test
catching it.

Same 458/477/479/480/485/487/491/492 sanctioned class — a
zero-coverage safety-critical helper used cross-package, with a
clean multi-range mutation-provable contract. No `.ts` source
change.

## Slice

- `packages/shared/test/strip-untrusted-terminal-chars.test.ts`
  — new file, 6 focused tests across the four ranges:
  - **C0 stripping** — ESC (`\x1b`) + BEL + NUL interleaved
    with printable text; the surrounding printable bytes are
    preserved verbatim.
  - **C0 whitelist preserved** — newline (`\x0a`) and tab
    (`\x09`) round-trip untouched.
  - **DEL stripped** (`\x7f`) — the central regex-range
    mutation-proven clause.
  - **C1 high-set stripped** — bare 8-bit CSI `\x9b`, the
    range endpoints `\x80` and `\x9f`.
  - **Unicode preservation** — emoji, CJK, Hangul, accented
    Latin all survive verbatim; only the control-byte ranges
    are removed.
  - **idempotent + empty** — empty input → empty output;
    `f(f(x))` = `f(x)` on clean text.
  Test inputs use `String.fromCharCode(0xNN)` so the source
  file stays byte-clean (no raw control bytes in the test
  source — confirmed by the project byte-scan).
- `packages/shared/src/index.ts` — **unchanged** (`git diff
  --stat` empty; test-only iteration mirroring goals
  458/477/479/480/485/487/491/492 verbatim).

## Verify

- New test 6/6 green; full `@muse/shared` suite green (18
  passed, +6, 0 failed); tsc strict (shared) EXIT=0.
- **Clean-mutation-proven** (Edit-based): trimming the regex
  range to `[\x00-\x08\x0b-\x1f]` (dropping DEL + C1) makes
  **two** tests fail with the precise pre-fix symptoms —
  `expected "safe<DEL>body" to be "safebody"` (DEL survives)
  and `expected "a<CSI>b<C1-padding>c<C1-app-cmd>d" to be "abcd"`
  (C1 high-set survives) — while the C0 / whitespace /
  Unicode / idempotent tests stay green; source restored
  byte-identical, suite back to 6 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean (test source has no raw control
  bytes; runtime strings are built via
  `String.fromCharCode`); `git status` shows only the one
  intended test file (src is unchanged).
- Pure regex sanitiser — no LLM / model request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. The single cross-package terminal-safety sanitizer — the
boundary every untrusted-text surface in Muse relies on — now
has direct coverage pinning its four-range contract; the DEL
and C1 high-set clauses are mutation-proven against the easy
"trim the regex" regression.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a 458-class direct coverage
addition on a zero-coverage cross-package safety helper,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Co-located the new test as a dedicated file rather than
  extending the existing `shared.test.ts` describe list: an
  attempt to extend the existing file ran into a tooling
  hazard where typed-literal control bytes leaked into the
  source (and the Edit tool's exact-match diff didn't accept
  byte-clean replacements over the contaminated lines). A
  fresh file with all inputs constructed via
  `String.fromCharCode` is the byte-safe, mutation-provable
  shape; the pattern matches the project's other
  per-helper test files.
- Mutation-proved the DEL + C1 trim specifically rather than
  the C0 whitelist: the C0 whitelist (`\x0a`, `\x09`) is
  positively pinned by the "preserves newline + tab" test;
  the DEL + C1 ranges are the easy-regression clauses
  (a future "simplify" PR would argue the C1 range is
  redundant on UTF-8 input — not realising bare 8-bit CSI
  `\x9b` is a legal one-byte terminal control on permissive
  terminals).
- Test-only (no source change); source restored byte-identical
  (`git diff --stat` empty for `packages/shared/src/index.ts`)
  — mirrors the 458/477/479/480/485/487/491/492 protocol.
