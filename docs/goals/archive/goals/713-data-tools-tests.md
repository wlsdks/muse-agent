# 713 — test: cover the LLM-facing data tools (math_eval / hash_text / csv_parse / base64) — they had zero tests despite a hand-rolled arithmetic parser

## Why

`packages/tools/src/muse-tools-data.ts` ships four tools the model can
call (math_eval, hash_text, csv_parse, base64) plus a hand-rolled
recursive-descent `evaluateArithmetic` parser — and had NO test
coverage at all. `testing.md` mandates direct unit coverage for every
helper export; a hand-rolled parser exposed to the LLM is exactly where
a precedence / div-by-zero / malformed-literal bug would silently give
the user a wrong answer. This iteration deliberately targets a
non-actuator area (the last three iterations all touched the
actuator/channel surface — PROCEDURE Step 8 stagnation guard).

## Slice

- `packages/tools/src/muse-tools-data.test.ts` (new): behavioral tests,
  not signature checks — they exercise real paths:
  - **math_eval**: precedence (`2 + 3 * 4`, `10 % 3 + 1`), parentheses,
    unary signs (`2 * -3`, `-(2+3)`, `2--3`), comma thousands
    separators, division/modulo by zero, empty / oversized (>256) /
    out-of-charset input, malformed literals (`1.2.3`), unbalanced
    parens, the unsupported `**` operator.
  - **hash_text**: sha256 default matches node's digest; sha1 / md5;
    case-insensitive algorithm; unknown-algorithm error; empty text.
  - **csv_parse**: header→objects (default); header:false→arrays;
    quoted fields, escaped `""`, embedded comma/newline, CRLF; empty
    text; short rows padded to header width.
  - **base64**: unicode encode→decode round-trip; url-safe output has no
    `+/=` and round-trips; invalid mode; non-base64 input;
    standard-alphabet input rejected under url-safe decode.

## Verify

- `@muse/tools` test: the new file passes (120 tools tests green).
- `pnpm check`: EXIT=0 (the new test initially failed `tsc` — `execute`
  takes `(args, context)` and returns a union; fixed with typed wrappers
  that pass a context and cast — caught precisely because `pnpm check`
  type-checks test files, unlike vitest's esbuild transform).
- `pnpm lint`: 0/0.
- No bug surfaced — the parser and tools are correct; this is genuine
  coverage of previously-zero-coverage LLM-facing tools, not a fix.
- No LLM request/response path touched (pure unit tests).

## Decisions

- **Behavioral over signature tests** — every assertion pins an actual
  computed result or error path; a parser test that only checked
  `2+2===4` would miss the precedence/unary/error cases that matter.
- **No CAPABILITIES line** — these tools already exist and ship; adding
  coverage is not a new user-facing capability, so claiming one would be
  dishonest. This is a `test:` hardening iteration.
