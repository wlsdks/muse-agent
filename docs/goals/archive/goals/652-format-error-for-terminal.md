# 652 — `@muse/shared` exports a one-stop `formatErrorForTerminal` helper that combines `stripUntrustedTerminalChars` + `truncateErrorBody` so a malicious upstream's `error.message` can't smuggle ANSI escape / BEL / DEL / C1 bytes into the user's terminal via `io.stderr` — applied first at the two `muse feeds` callsites that print errors from arbitrary HTTP feed servers

## Why

Across the codebase, error-to-stderr formatting follows the same
shape:

```ts
io.stderr(`...: ${cause instanceof Error ? cause.message : String(cause)}\n`);
```

The `cause.message` lands on the user's terminal **without
sanitization**. When the error comes from an external source —
an HTTP response body, a malformed RSS feed, an untrusted file,
a model output — the message can carry ANSI escape sequences,
BEL bytes, OSC sequences, or C1 control codes that a permissive
terminal will execute:

- **`\x1b[2J`** clears the screen, hiding the real output
  above the error.
- **`\x1b]0;pwned\x07`** sets the terminal title (cosmetic but
  reveals execution).
- **`\x1b[31m...`** colourises text so an attacker-crafted
  "WARNING: ..." message looks like real Muse styling.
- **`\x9b...`** bare CSI on permissive terminals (iTerm2,
  some Linux consoles) executes without the `\x1b[` prefix.
- **OSC 52** (`\x1b]52;c;<base64>\x07`) sets the system
  clipboard on many terminals.
- **DEL / NUL** can corrupt log-aggregator parsers downstream.

The codebase already has `stripUntrustedTerminalChars` in
`@muse/shared` (goal 003) but it's NOT applied at error-message
print sites. Every `cause.message` reaching `io.stderr` is a
potential injection vector.

The fix:

1. **Add `formatErrorForTerminal(cause, cap?)`** to
   `@muse/shared`. Single-call sanitizer: extract the
   message (Error instance OR String fallback), strip the
   control bytes, truncate to the existing
   `DEFAULT_ERROR_BODY_CAP` (240). One function so every
   future error-print site has the safe shape.
2. **Apply at the two `muse feeds` callsites** in this iter
   — they're the most clearly-exposed sites in the CLI
   (errors from `loadFeedBody`'s arbitrary HTTP fetch +
   `parseFeedBody`'s untrusted XML can carry attacker-
   controlled bytes in their messages).
3. **Sibling-fixable elsewhere** in future iters
   (commands-watch-folder, chat-repl-slash, commands-brief,
   etc.). Tight scope for this iter.

### Defect class

**Error message printed to terminal without control-char
sanitization** — first hit. Fresh against the recent 10-iter
window:

- 651: non-crypto RNG for security token
- 650: LLM timestamp sanity bound
- 649: unbounded HTTP body
- 648: HTTP fetch timeout
- 647: bracket parser inString
- 646: FIFO cap
- 645: file mode 0o600
- 644: finite-guard data destruction
- 643: strict int-parse
- 642: stream error listener

None previously hit the "ANSI escape sequence in error
message reaches terminal" class. Sibling to the existing
`stripUntrustedTerminalChars` infrastructure but applied at
the error-print boundary that was missed.

## Slice

- `packages/shared/src/index.ts`:
  - **New export `formatErrorForTerminal(cause: unknown,
    cap: number = DEFAULT_ERROR_BODY_CAP): string`**. Pure
    composition: `truncateErrorBody(stripUntrustedTerminalChars(message), cap)`
    where `message = cause instanceof Error ? cause.message :
    String(cause)`.
  - Order matters: strip FIRST so the cap counts only
    printable chars (an operator who sees "240 chars
    truncated" expects 240 visible chars, not 100 visible +
    140 invisible escape bytes).
- `apps/cli/src/commands-feeds.ts`:
  - Imported `formatErrorForTerminal` alongside the existing
    `stripUntrustedTerminalChars`.
  - **Two callsites swapped**:
    - `refreshSingleFeed` (line ~152): error from
      `loadFeedBody` / `parseFeedBody` now flows through
      `formatErrorForTerminal(cause)`.
    - `feeds add` initial fetch (line ~195): same pattern.
- `packages/shared/test/shared.test.ts`:
  - Import updated.
  - **Seven new tests** covering:
    1. Message extracted from Error instance.
    2. Non-Error fallback via `String(cause)` (string,
       number, custom toString).
    3. ANSI escape / BEL / DEL / C1 byte set stripped —
       pre-fix's raw message would let `\x1b[2J` reach the
       terminal.
    4. Newline + tab preserved (only the dangerous set is
       stripped).
    5. Default body cap applied so a huge upstream message
       can't flood stderr.
    6. Explicit cap arg honoured.
    7. Empty-message Error returns `""` (no spurious "…" or
       "Error" fallback string).

## Verify

- `pnpm --filter @muse/shared test`: 28 passed (21 prior +
  7 new). `pnpm check` full: every workspace green.
  `agent-core` 667, `mcp` 538, `apps/api` 270, `apps/cli`
  1119, `multi-agent` 51, `scheduler` 85, `autoconfigure`
  147, `shared` 28. tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the strip step from
  the helper body (removing
  `stripUntrustedTerminalChars(...)` so the function becomes
  `truncateErrorBody(message, cap)`) makes EXACTLY one test
  fail — the ANSI-strip test, with the exact symptom that
  the raw `\x1b[2J\x1b]0;pwned\x07...` bytes survive into
  the output. The other 6 tests pass either way (they don't
  exercise the strip step). Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the three touched files: clean.
- No LLM request/response wire path touched. `smoke:live`
  doesn't apply.

## Status

Done. A malicious feed server returning an error with
embedded ESC bytes can no longer hijack the user's terminal
via `muse feeds refresh` or `muse feeds add`:

| Upstream error.message                              | Pre-fix at io.stderr                  | Post-fix                                   |
| --------------------------------------------------- | ------------------------------------- | ------------------------------------------ |
| Plain `"connection refused"`                        | unchanged                              | unchanged                                  |
| `\x1b[2JCleared your screen`                        | **screen wiped**                       | `[2JCleared your screen` (no escape)       |
| `\x1b]52;c;Zm9v\x07` (OSC 52 clipboard set)         | **clipboard hijacked**                 | `]52;c;Zm9v` (no OSC trigger)              |
| 10 KB of `xxx...x` (malicious flood)                | **stderr flooded**                     | Capped at 240 chars + `…`                  |
| `\x1b[31mWARNING: enter your password here:`        | **fake-styled phishing prompt**        | `[31mWARNING: ...` (no colour code)        |

## Decisions

- **Order: strip FIRST, then truncate**. Visible-char
  semantics: the cap should count printable bytes. Reversing
  the order (truncate then strip) would let an attacker
  embed 240 bytes of `\x1b...` to push real content out of
  the visible window before the strip ran. Tested implicitly
  via the cap test against `"x".repeat(...)` (pure
  printables) — the order doesn't matter for pure
  printables, but the contract is the safer one.
- **Don't redact secrets in this helper**. The codebase has
  `redactSecretsInText` (goal 086) for that — separate
  concern, separate composition. Operators who want both
  can wrap: `redactSecretsInText(formatErrorForTerminal(cause))`.
- **Default cap = DEFAULT_ERROR_BODY_CAP (240)**, matching
  every other error-body site in the codebase. Operators
  who need a tighter / looser bound pass an explicit `cap`
  arg.
- **Empty-message handling**: a `new Error("")` returns `""`
  (not "Error" or "(empty)"). Caller decides what to show
  when the error has no message — usually the surrounding
  template provides context (e.g., `"add failed: "` prefix
  is enough).
- **Apply only at the 2 feed sites in this iter**.
  Sibling-fixable elsewhere — watch-folder, chat-repl-slash,
  commands-brief, commands-notes-rag, etc. Each is its own
  iter when defect-class rotation circles back. The feed
  sites are the highest-leverage because they're the only
  CLI surface that prints errors from **arbitrary
  third-party HTTP servers** by design.
- **Mutation choice**. Reverted the strip step only. The
  ANSI-strip test fails with the exact byte-level symptom;
  the 6 other tests pass regardless. Surgical proof.

## Remaining risks

- **Other `io.stderr` error sites** still take raw
  `cause.message`:
  - `apps/cli/src/commands-watch-folder.ts` (3 sites) —
    file-read errors from a watched directory could leak
    filename bytes into the message.
  - `apps/cli/src/commands-brief.ts:126` — TTS / model
    error.
  - `apps/cli/src/commands-notes-rag.ts:412` —
    auto-reindex error.
  - `apps/cli/src/chat-repl-slash.ts:271` — `/remember`
    error.
  - `apps/cli/src/commands-objectives.ts:69` — objectives
    error.
  - `apps/cli/src/commands-feeds.ts:152, 195` — **done in
    this iter**.
  - Many more across `apps/cli/src/*`.
  Each is its own sibling-iter when defect-class rotation
  circles back to "error-to-terminal sanitization".
- **`io.stdout` paths too**. The same `cause.message`
  pattern appears in some success-path-but-degraded
  outputs (e.g., partial success on a multi-feed refresh).
  Out of scope for this iter.
- **Error message might still leak secrets** even after
  sanitization. The auth-key family of patterns is caught
  by `redactSecretsInText` (goal 086) but not invoked
  here. Composing the two at the same sites is a future
  iter.
- **Terminal-emulator interpretation varies**. Some
  terminals (e.g., the macOS Terminal.app) ignore C1 bytes
  in `\x80-\x9f`; iTerm2 honours them. The strip catches
  the union (everything from `\x00-\x08`, `\x0b-\x1f`,
  `\x7f-\x9f`), so the fix is the widest-safe baseline.
- **`String(cause)` for non-Error throwables can still
  return weird output** (e.g., `String([1,2,3])` is
  `"1,2,3"`). The strip step still cleans control bytes
  from that output; the helper isn't trying to make
  non-Error throwables look pretty, just safe.
