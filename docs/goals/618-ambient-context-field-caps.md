# 618 — `renderAmbientContextSection` caps each ambient field (`app` / `window` / `selected` / `clipboard` / `notifications`) at a sensible char budget so a multi-MB clipboard paste / huge selected text can't inflate the system prompt unboundedly

## Why

`packages/agent-core/src/ambient-context.ts:renderAmbientContextSection`
is the renderer for `[Ambient Context]`, the system-prompt block
that exposes the operator's environment (frontmost app, window
title, selected text, clipboard, notifications summary) to the
agent. Each field is passed through `sanitizeInline`:

```ts
function sanitizeInline(value: string): string {
  return stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim();
}
```

That collapses whitespace + strips ESC / C0 / C1 / DEL bytes —
exactly the right injection defenses. But **none of the fields
had a length cap**. A user who copies a 5 MB code file into the
clipboard (or selects an entire long document, or has a
notifications summary that's grown large) would balloon the
`[Ambient Context]` block by that much. Two failure modes:

1. **Context-window pressure** — every other system section
   (active context, attached files, persona, recent memory) is
   crowded out. The agent's effective working context shrinks
   to whatever fits after the clipboard fills the prompt.
2. **Per-request CPU** — `stripUntrustedTerminalChars` is a
   regex pass over the whole string. A 100 MB clipboard
   triggers a 100 MB regex scan every turn.

The sibling `attachment-context.ts` already solves both — its
`sanitizeAndBound(raw, max)` pre-slices to `2*max` BEFORE the
regex pass (bounded CPU) and truncates the post-sanitize output
to `max` chars with a `…` suffix (bounded prompt). Ambient
context never picked up the same pattern.

Step-8 redirect: not file-mode (616), not atomic-write (617),
not list-ordering (615), not CLI UX (614), not Date overflow
(613), not boolean spelling (612), not validation parity (611).
Closest in spirit is goal 604 (memory cap on `muse.fetch` body),
14 commits back — outside the last-10 window, fresh enough. The
shape is "render-boundary length cap on untrusted user-environment
input."

## Slice

- `packages/agent-core/src/ambient-context.ts`:
  - Five per-field cap constants:
    - `MAX_APP_CHARS = 256` (app binary name / short label)
    - `MAX_WINDOW_CHARS = 256` (window title / terminal title)
    - `MAX_SELECTED_CHARS = 2048` (selected text body)
    - `MAX_CLIPBOARD_CHARS = 2048` (clipboard body)
    - `MAX_NOTIFICATIONS_CHARS = 2048` (notifications summary)
  - Replaced `sanitizeInline` with `sanitizeAndBound(raw, max)`
    — same shape as `attachment-context.ts:sanitizeAndBound`:
    pre-slice to `2*max` for bounded regex CPU, then sanitize,
    then truncate to `max` chars with a `…` ellipsis suffix.
  - `renderAmbientContextSection`'s field-loop now passes the
    per-field cap alongside the value, so each field's budget
    is data-driven (a future addition just adds another tuple
    row, no code-shape change).
- `packages/agent-core/test/ambient-context.test.ts`:
  - One new test in the existing `renderAmbientContextSection`
    describe. Constructs a snapshot with a 10_000-char clipboard,
    5_000-char selected, 2_000-char app — totals 17_000 chars
    raw. Asserts the rendered output is under 10_000 chars
    (post-cap, the block is ~4_500 chars), contains the `…`
    truncation marker, AND short fields still render verbatim
    without an ellipsis (the cap doesn't mangle normal values).

## Verify

- `@muse/agent-core` suite green (661 passed, +1 vs baseline 660,
  0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `sanitizeAndBound` back to the unbounded `sanitizeInline`
  makes the new test fail with `rendered length 17046 must be
  under the raw-input total — caps must clamp each field:
  expected 17046 to be less than 10000` — exact pre-fix
  unbounded-render symptom (17_046 chars = the 17_000 raw
  inputs plus the `[Ambient Context]\napp: \nclipboard: \nselected: ` overhead).
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1048
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched directly; the
  render boundary is the system-prompt assembler, not the
  model call itself. `smoke:live` doesn't apply — the cap is
  a pure-function transform on a string, no provider
  round-trip needed to verify.

## Status

Done. Ambient-context render boundary now bounds every field
the same way the sibling attachment-context already did:

| Field           | Cap before        | Cap after        |
| --------------- | ----------------- | ---------------- |
| `app`           | **unbounded**     | 256 chars        |
| `window`        | **unbounded**     | 256 chars        |
| `selected`      | **unbounded**     | 2048 chars       |
| `clipboard`     | **unbounded**     | 2048 chars       |
| `notifications` | **unbounded**     | 2048 chars       |

Per-render CPU: the regex pass now runs over at most `2*max`
chars per field (combined ceiling ~12 KB), regardless of the
raw input size. A 100 MB clipboard scan is bounded by the
2*2048 = 4 KB pre-slice.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
prompt-budget defensive `fix:` on the ambient-context render
boundary, recorded honestly with this backlog row — not a false
metric.

## Decisions

- **Cap values asymmetric (`256` for identifiers vs `2048` for
  bodies).** `app` and `window` are short by their nature — a
  binary name like `Code` or a terminal title rarely exceeds
  100 chars. Capping at 256 is generous. `selected` / `clipboard`
  / `notifications` carry substantive content the user might
  want the agent to perceive — 2 KB each balances "enough for
  most natural use" against "bounded enough to not dominate
  the prompt." Total worst-case ~6.5 KB of ambient text — small
  fraction of even a 32 K context window.
- **Pre-slice before sanitize**, not after. `stripUntrustedTerminalChars`
  is a regex pass; running it over 100 MB just to throw the
  result away is wasted CPU. Pre-slicing to `2*max` (the slack
  accounts for whitespace collapse and trim potentially
  reducing length) keeps the regex work O(cap) regardless of
  input size — same pattern attachment-context.ts uses on
  goal-091-era text fields.
- **`…` ellipsis suffix** (Unicode U+2026, single char) over a
  multi-char `...`. Saves prompt tokens; signals truncation in
  one visible character; matches the attachment-context
  convention.
- **Field-loop carries the cap as a tuple element**, not a
  switch in `sanitizeAndBound`. Data-driven: adding a new
  field is one tuple row, not a new branch. A future iteration
  that adds (say) `recent_files: string` only writes a new
  cap constant + appends to the tuple list.
- **Mutation choice.** Reverted exactly the `sanitizeAndBound`
  function + the field-loop's per-field cap argument back to
  the inline-only shape. The mutation reproduces the pre-fix
  shape — a maintainer "inlining the sanitiser back to keep
  the file shorter" would land exactly that diff. The
  mutation test catches it with the exact 17 K-char overflow.
- **Test uses one big snapshot rather than three small ones**.
  Verifies the combined budget; pinning each field cap
  individually would be three tests for the same defect.
  The "short fields still render verbatim" tail-assertion
  pins the happy path stays unchanged.

## Remaining risks

- **`AmbientSnapshot` interface** still accepts arbitrary-length
  strings — the cap is enforced ONLY at render time. A
  downstream consumer that reads the raw `AmbientSnapshot`
  before rendering (a metrics emitter, a snapshot persister)
  would see the full unbounded text. Out of scope here — the
  render boundary is where prompt-budget concerns live; the
  raw snapshot type is the dispatcher's contract.
- **Counted-char vs counted-byte caps**. A 2048-char string of
  multi-byte UTF-8 (emoji, CJK) is up to ~8 KB at the wire
  level. The cap is char-count, matching the JS string length
  convention; the byte cap is implicit and would only matter
  for a model adapter that bills by bytes (none today). Out
  of scope.
- **Per-field CPU cap is bounded**, but the OUTER `for-of` over
  five fields is constant — no per-snapshot fan-out hazard.
  A future addition that loops over an array-shaped field
  (`recent_files: string[]`) would need its own per-entry cap
  + entry-count cap, mirroring attachment-context's
  `MAX_ATTACHMENT_ENTRIES`.
- **No structural-field validation** (e.g. "app must be a
  printable ASCII identifier"). A clipboard containing only
  whitespace renders empty after trim — fine. A clipboard
  containing only zero-width characters is similarly trimmed
  by `stripUntrustedTerminalChars`. Out of scope here.
