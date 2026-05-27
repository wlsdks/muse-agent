# 637 — `muse.crypto.base64` decode validates the input shape (alphabet + length-mod-4 + padding) before handing it to Node's lenient `Buffer.from(text, "base64")` decoder, so a malformed input returns a clear error instead of silently emitting garbled bytes — sibling-parity with the `hex` decode that's already strict

## Why

`packages/mcp/src/loopback-crypto.ts:createCryptoMcpServer`
exposes three encoder/decoder tools to the LLM as MCP
loopbacks: `hash`, `base64`, `hex`. Pre-fix base64 decode:

```ts
if (mode === "encode") {
  return { mode, output: Buffer.from(text, "utf8").toString("base64") };
}
const decoded = Buffer.from(text, "base64").toString("utf8");
return { mode, output: decoded };
```

No input validation. **Node's `Buffer.from(text, "base64")` is
intentionally lenient by design** — per the docs:

> "Characters that are not in the Base64 alphabet are silently
> ignored."

So `Buffer.from("not-base64!", "base64").toString("utf8")`
returns `"��~m��"` (garbage). The tool reports `mode: "decode",
output: "<garbage>"` as if the decode succeeded. The agent
either acts on garbage or — more often — gets confused and
asks the user to clarify. Worse, the garbage is sometimes
valid-looking UTF-8 (random byte combinations occasionally
land on printable ASCII), so the LLM can't even reliably
detect the bad input.

The sibling `hex` tool at line 116 ALREADY does the strict
check:

```ts
if (!/^[0-9a-fA-F]*$/u.test(text) || text.length % 2 !== 0) {
  return { error: "input is not a valid hex string" };
}
return { mode, output: Buffer.from(text, "hex").toString("utf8") };
```

`base64` was the missed sibling — same encode/decode shape,
same JSON-Schema enum on mode, same callsite pattern,
inconsistent validation rigor.

This iter's defect class — **lenient `Buffer.from`-style
decode silently emits garbled bytes on malformed input;
sibling-parity gap between hex and base64 validation** — is
fresh against the recent window:

- 636: HTTP timeout (network)
- 635: per-file concurrent write (memory store)
- 634: sort tiebreaker
- 633: surrogate-pair truncation
- 632: tilde-expansion
- 631: per-file concurrent write (messaging)
- 630: mkdtemp directory cleanup
- 629: per-entry validation
- 628: unit-promotion + finite-guard
- 627: tolerant-read nested array

Decoder-input validation hasn't been hit. Closest sibling is
the existing hex decode validation (already in place), and
goal 625 (strict env-parse), but that's about LENIENT
`parseInt` not LENIENT `Buffer.from`.

## Slice

- `packages/mcp/src/loopback-crypto.ts`:
  - Added one validation block before the `Buffer.from(text,
    "base64")` call in the decode branch:
    ```ts
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text) || text.length % 4 !== 0) {
      return { error: "input is not a valid base64 string" };
    }
    ```
  - The regex covers the standard base64 alphabet
    (`A-Z`, `a-z`, `0-9`, `+`, `/`) plus 0-2 `=` padding chars
    at the end. The length-mod-4 check rejects truncated
    encodings (any well-formed base64 has length divisible
    by 4 after padding).
  - Encode branch is untouched.
  - Empty string (`""`) passes both checks (regex matches
    zero chars, length 0 % 4 === 0) and decodes to `""` —
    the only legitimate empty case.
- `packages/mcp/test/mcp.test.ts`:
  - One new test in the existing `loopback.crypto` describe.
    Six assertions covering every meaningful branch:
    1. `"not-base64!"` (contains `!` and `-`, neither in
       alphabet) → error
    2. `"abc"` (3 chars, length 3 % 4 !== 0) → error
    3. `"aGVsbG8 jarvis"` (contains space, not in alphabet)
       → error
    4. `"aGVsbG8=jarvis"` (padding `=` not at the END) →
       error
    5. `"aGVsbG8gamFydmlz"` (valid encode of "hello jarvis")
       → success, decoded back
    6. `""` (empty input) → success, empty output (no
       error — empty is a legitimate edge)

## Verify

- `@muse/mcp` suite green (537 passed, +1 vs the pre-iter
  baseline of 536, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the
  validation block back to the bare `Buffer.from(text,
  "base64")` makes the new test fail with the EXACT pre-fix
  symptom: `Received: { mode: "decode", output: "<garbled>" }`
  vs. `Expected: { error: "input is not a valid base64
  string" }`. The pre-existing `base64 round-trips
  encode/decode` test passes pre- AND post-fix because its
  input is valid base64 — confirms the fix is purely
  additive on healthy inputs.
- **One follow-up fix during the iter**: the `@muse/shared`
  byte-hygiene test caught a U+200D Zero-Width Joiner in
  goal 636's doc (recurring family-emoji issue from goals
  633/634/635). Replaced inline with textual `U+200D`
  notation, same fix iters 606+ use. Pattern is now
  documented enough that a future iter should sweep all
  docs to avoid recurrence.
- `pnpm check` green: apps/api 261/261, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean
  on the touched files.
- No LLM request/response wire path touched — this is the
  MCP loopback tool surface the LLM CALLS, but the
  validation runs locally before any encode/decode.
  `smoke:live` doesn't apply.

## Status

Done. `muse.crypto.base64` decode is now strict, matching the
hex decode contract:

| Input                            | Before                          | After                       |
| -------------------------------- | ------------------------------- | --------------------------- |
| `"aGVsbG8gamFydmlz"` (valid)     | `"hello jarvis"`                | unchanged                   |
| `""` (empty)                     | `""`                            | unchanged                   |
| `"not-base64!"` (bad chars)      | **`"��~m��"` garbled**           | clean error (**fixed**)     |
| `"abc"` (length 3, not %4)       | **garbled** (silent drop)       | clean error (**fixed**)     |
| `"aGVsbG8 jarvis"` (space)       | **garbled**                     | clean error (**fixed**)     |
| `"aGVsbG8=jarvis"` (mid-padding) | **garbled**                     | clean error (**fixed**)     |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness
/ decoder-validation `fix:`. Recorded honestly with this
backlog row.

## Decisions

- **Standard base64 alphabet only**, NOT base64url. The MCP
  tool's encode side emits standard base64 (Node's
  `Buffer.from(text, "utf8").toString("base64")` uses `+`
  and `/`, not `-` and `_`). Round-trip symmetry requires
  the decode to accept what encode emits. A separate
  `base64url` mode could be a future iter.
- **`={0,2}` padding check** — base64 outputs end with 0, 1,
  or 2 `=` characters. Anywhere else, `=` is invalid. The
  regex anchor `={0,2}$` enforces "padding at end only" so
  `"aGVsbG8=jarvis"` (which has padding in the middle) is
  rejected.
- **Length-mod-4 check** is BOTH needed AND insufficient
  alone — `"abc"` (length 3) is rejected by length only.
  But `"ab="` (length 3 padded → 4) is invalid per the
  regex (which doesn't allow 1 `=` after 2 chars; the regex
  treats any char as alphabet+padding but the math is
  enforced by length-mod-4). Both checks together are
  tight.
- **`""` empty string is valid** (decodes to `""`). The
  regex matches zero characters (the `*` quantifier) and
  length 0 % 4 === 0. Symmetric with the encode side
  (encoding `""` returns `""`).
- **Did NOT also add an explicit-error path that includes
  the bad character** for diagnostics. The error message
  matches the hex sibling's format exactly (`"input is not
  a valid <type> string"`) — sibling-parity beats
  diagnostics here. An agent that hits this error
  understands the contract from the message; deeper
  diagnostics would only help a human debugger.
- **Mutation choice.** Reverted only the two-line
  validation block. One new test fails with the exact
  pre-fix symptom (garbled output). Five of the six new
  assertions test the error path; one tests the success
  path. The pre-existing tests pass pre- AND post-fix —
  confirms the fix is surgical to the malformed-input
  branch.

## Remaining risks

- **base64url isn't accepted by `muse.crypto.base64`.** A
  caller who knows that `Buffer.from(text, "base64url")` is
  a thing would expect both alphabets to work. They don't,
  by design — encode/decode round-trip uses standard
  base64. If a future MCP caller needs base64url they can
  add a dedicated tool / mode.
- **Whitespace tolerance.** Some base64 specs (RFC 4648
  with `\n` interleave for MIME) accept whitespace between
  chunks. This implementation rejects it. The encode side
  doesn't EMIT whitespace, so symmetry holds; if a third-
  party encoded body has line-wrapped base64 a future iter
  could allow it via a flag.
- **Hex decode validation already strict.** No follow-up
  needed for hex.
- **Other lenient `Buffer.from(_, "base64")` callsites**
  could exist. A quick grep would find them; this iter
  scoped to the MCP loopback tool the LLM directly
  invokes — that's the highest-leverage surface.
- **U+200D family-emoji recurrence.** Goal 633, 634, 635,
  636, and now 637 all surfaced the same byte-hygiene
  failure in their docs. The pattern is well-documented;
  a future iter could sweep `docs/goals/` for ANY
  remaining literal U+200D in one pass to break the
  recurrence.
