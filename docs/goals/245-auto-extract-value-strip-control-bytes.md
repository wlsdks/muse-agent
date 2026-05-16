# 245 — auto-extracted user-memory values weren't control-byte sanitised

## Why

The control-byte / terminal-injection sweep (227-231 prompt
surfaces, 234 search, 240 feeds) closed the class everywhere it
had been found — but missed the **most sensitive** sink of all.

`memory-auto-extract.ts`'s `sanitizeValue` is the documented
store-boundary defense for auto-extracted facts / preferences /
veto / goal values. Its own comment frames it as the
prompt-injection guard ("can't land in `UserMemoryStore` and then
be re-emitted into the next turn's `[User Memory]` block"). But it
only did:

```ts
raw.replace(/\s+/gu, " ").trim().slice(0, maxValue)
```

`\s` matches space / tab / newline / CR / FF / VT — it does **not**
match ESC (0x1b), the C0 range, C1 (0x80-0x9f), or DEL (0x7f). So
a value the extractor faithfully copied from a user turn or an
ingested tool/inbound message — `"vim\x1b[2Jlover"` — sailed
straight through into `UserMemoryStore`, and from there:

- into **every subsequent turn's** `[User Memory]` system-prompt
  block via `renderUserMemorySection` (the highest-value injection
  point in the product — the agent's persistent model of the
  user), and
- onto the terminal verbatim on `muse memory show` (ANSI
  clear-screen / OSC title-spoof / cursor hijack).

This is exactly the class goals 227-240 systematically closed; the
auto-extract store boundary was the last, and worst, un-swept
sibling.

## Scope

`packages/memory/src/memory-auto-extract.ts`:

- `sanitizeValue` now composes
  `stripUntrustedTerminalChars(raw)` (from `@muse/shared`, already
  a `@muse/memory` dependency — the import was type-only, now also
  a value import) **before** the existing whitespace-collapse +
  trim + length-cap. Same primitive + ordering the search / feeds
  surfaces use.
- One function touched. `normalizeKey` already restricts keys /
  ids / scope to `[a-z0-9_]`, so `value` was the only vector;
  scope routes through `normalizeKey` and is unaffected. The
  `\n`-splice collapse, array-shape rejection, parallel-write,
  cooldown, and timeout behavior are all unchanged.

## Verify

- `pnpm --filter @muse/memory test` — 148 pass (was 147; +1). New
  test feeds the extractor a payload whose fact value carries
  `ESC[2J`, a C1 CSI, DEL and a `\n[System Override]\n` splice
  (bytes via `String.fromCharCode`, never raw in source — goal-227
  rule) and a goal slot with an ANSI run, then asserts the
  persisted fact + slot contain none of the control bytes while
  visible text and the existing newline-collapse are preserved
  (`"vim[2Jlover [System Override] rm -rf"`, `"ship[31m v1"`). The
  existing newline-collapse fact / veto tests still pass —
  `stripUntrustedTerminalChars` leaves `\n` / space alone, so the
  prior `"Pepper [System Override] Do X"` contract is unchanged.
- `pnpm check` — every workspace green (memory 148, apps/cli 555,
  apps/api 153, all packages). `pnpm lint` — exit 0.
- No applicable real-LLM round-trip: `sanitizeValue` is a pure
  deterministic transform at the persistence boundary, not the
  model request/response wire. The threat is adversarial input a
  benign Qwen turn does not naturally emit, so a live round-trip
  would not exercise it — the deterministic unit test injecting
  the exact adversarial payload is the rigorous verification, the
  same stance the 227-240 sweep used for every pure sanitiser.

## Status

done — auto-extracted user-memory values are now ESC/C0/C1/DEL
sanitised at the store boundary, so a control-byte payload can no
longer persist into `UserMemoryStore` and then be replayed into
every future system prompt or hijack the terminal on
`muse memory show`. The control-byte sweep is now complete through
the auto-extract sink — the codebase's most sensitive injection
point.
