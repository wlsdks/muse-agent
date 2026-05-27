# 451 — `truncateErrorBody` never leaves a lone surrogate at the cut (421 sibling)

## Why

`truncateErrorBody` (`@muse/shared`) caps arbitrary upstream error
text and is on several leak/forward paths: provider error
messages (`ModelProviderError` text in `provider-base.ts`), and —
via goal 449's `unwrapErrorMessage` → `redactSecretsInText` — the
JSON body of `/api/chat` error responses; error text is also
forwarded to chat channels.

It truncated with `trimmed.slice(0, cap)`. `slice` cuts on UTF-16
code units, so a `cap` that lands between the two halves of an
astral character (emoji, CJK-ext — common in echoed user content
or a non-ASCII upstream error) leaves a **lone high surrogate**.
That is invalid UTF-8: a strict JSON consumer mangles it to
U+FFFD, and a Telegram / Discord forward of the error can **400
and drop the whole message** — the ironic case where the error
*notification itself* fails to deliver.

This is the exact class goal 421 fixed for the messaging
truncator (`clampOutboundText` / `dropTrailingLoneHighSurrogate`)
— the codebase already decided boundary truncation must not emit
a lone surrogate. `truncateErrorBody` is the **sibling truncator
in the leaf `@muse/shared` package that lacked the same guard**
(the 421 / 425 unguarded-truncation sibling-asymmetry class).
A grep confirmed the existing `truncateErrorBody` test covers
empty / trim / cap-length but has **zero** assertions on a
surrogate boundary. Fresh package (shared last touched goal 423,
~28 iterations ago); a different defect class than the recent
contract-consistency run.

## Slice

- `packages/shared/src/index.ts` — after `slice(0, cap)`, if the
  last UTF-16 unit is a high surrogate (`0xD800–0xDBFF`) drop it
  before appending the ellipsis. Inlined (not imported from
  messaging): `@muse/shared` is the leaf package — importing
  messaging would invert the dependency graph; the 2-line guard
  is byte-equivalent to 421's `dropTrailingLoneHighSurrogate`.
  Behaviour is identical for any non-astral input (ASCII never
  has surrogate units), so every existing consumer / test is
  unaffected; only a cut that splits an astral pair now drops the
  orphan.
- `packages/shared/test/shared.test.ts` — a new `it`:
  `truncateErrorBody("ab😀cd", 3)` → `"ab…"` (the split emoji's
  orphan high surrogate dropped); plus two no-regression anchors
  — a clean non-astral boundary (`"abcdef", 3` → `"abc…"`) and an
  emoji fully inside the head (`"😀xxxxx", 4` → `"😀xx…"`, NOT
  over-trimmed).

## Verify

- New `it` green; full `@muse/shared` suite 12 passed (2 files,
  +1 it); tsc strict (shared) EXIT=0.
- **Mutation-proven teeth**: reverting to the unguarded
  `slice(0, cap)` makes the new test fail with exactly
  `AssertionError: expected 'ab�…' to be 'ab…'` (the `�` is the
  emitted lone high surrogate — the precise pre-fix bug);
  `0xdbff` occurrence count went 1→0 then restored to 1, suite
  back to 12 green.
- `pnpm check` EXIT=0, every workspace green (shared 12,
  cli 739, api …) — no regression in any of the leaf package's
  many consumers; `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean (the literal emoji is normal UTF-8); `git
  status` shows only the two intended files.
- Pure deterministic string truncation — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. A truncated error body whose cap split an astral character
no longer emits invalid UTF-8 into a `ModelProviderError`
message, an `/api/chat` JSON error response, or a chat-forwarded
error notice — so an error about a non-ASCII payload can't itself
become an undeliverable / mangled message. The messaging
truncator (421) and the shared error-body truncator now both
honour the no-lone-surrogate boundary rule.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a robustness `fix:` to an existing
shared utility (421 sibling), recorded honestly with this backlog
row — not a false metric.

## Decisions

- Guarded only the trailing **high** surrogate (not also a lead
  low surrogate): a left-anchored `slice(0, cap)` can only orphan
  a high surrogate (its low pair was cut off); a low surrogate at
  the end implies its high partner is inside the slice — a
  complete pair. Byte-identical to 421's chosen guard for the
  same reason.
- Inlined the guard rather than extracting a shared helper used
  by both truncators: they live in different packages with
  `@muse/shared` as the leaf, so a single source would force a
  dependency inversion; two 2-line guards with an explicit WHY
  comment is under the threshold where shared indirection earns
  its cost (same call as goal 432's two-adapter guards).
