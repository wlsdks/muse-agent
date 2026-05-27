# 500 — `sanitizeFollowupSummary` drops a lone surrogate at the 160-char cap (goal-451/499 sibling, persistence-time)

## Why

`sanitizeFollowupSummary` (`@muse/agent-core`
`followup-capture-hook.ts:110`) is the persistence-time
sanitiser the followup-capture hook applies to assistant turns
before writing them to the followup store. The persisted text
later flows out through `runDueFollowupNotices` to **Telegram /
Slack / log** messaging providers — exactly the channels that
400 on invalid UTF-8.

Pre-fix the function did:

```ts
return stripped.slice(0, MAX_SUMMARY_CHARS);
```

The same UTF-16-units defect goal 451 fixed for
`truncateErrorBody` and goal 499 fixed for
`createMaxLengthResponseFilter`. If the 160-char cap falls
inside a surrogate pair (an emoji or any supplementary-plane
character), the slice emits a **lone high surrogate** — invalid
UTF-8 a downstream messaging-provider write either replaces
with U+FFFD or rejects entirely. Real and reachable: a
followup captured from a Korean / emoji-heavy assistant turn
("Q3 메모 보내기 😀 …" at the 160-char boundary) silently
corrupts the message sent to the user's channel.

This is the **third** consumer of the same defect class (after
451 / 499). Same pattern, same fix shape.

## Slice

- `packages/agent-core/src/followup-capture-hook.ts` — after
  the `slice(0, MAX_SUMMARY_CHARS)`, check
  `charCodeAt(head.length - 1)` for a high surrogate
  (`0xd800-0xdbff`) and drop it with another `slice(0, -1)`.
  Same byte-identical pattern as 451 / 499. Behaviour
  byte-identical for every truncation that doesn't land on a
  surrogate boundary.
- `packages/agent-core/test/followup-capture-hook.test.ts` —
  extended the existing 3-test `sanitizeFollowupSummary`
  describe (each prior assertion untouched) with a focused
  emoji-at-boundary case: `"x" * 159 + "😀" + filler` →
  expected `"x" * 159` (the orphan dropped), and the
  trailing charCodeAt isn't a high surrogate.

## Verify

- New test green; the 3 pre-existing `sanitizeFollowupSummary`
  assertions still green (no wrong premise — the
  `"x".repeat(500)` cap-to-160 test stays exact since no
  surrogate lands on the boundary); full `@muse/agent-core`
  suite green (632 passed, +1 new it, 0 failed); tsc strict
  (agent-core) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  surrogate-drop block to a plain
  `return stripped.slice(0, MAX_SUMMARY_CHARS)` makes the new
  emoji-at-boundary test fail (its assertion that the result
  is `"x" * 159` and not `"x" * 159 + "\uD83D"`) while the
  three pre-existing tests stay green; fix restored, suite
  back to 4 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure persistence-time sanitiser — no LLM / model
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. A followup captured from a model turn whose 160-char cap
lands inside an emoji's surrogate pair no longer routes invalid
UTF-8 out to Telegram / Slack / log. Together with goals
451 (`truncateErrorBody`) and 499
(`createMaxLengthResponseFilter`), the three known
fixed-character-cap surrogate-safety consumers are now
mutation-proven; the codebase-wide pattern is single-shaped.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a goal-451/499 sibling
correctness `fix:` on a third consumer, recorded honestly
with this backlog row — not a false metric.

## Decisions

- Mirrored goals 451 / 499's surrogate-drop shape byte-for-
  byte (length-precheck → slice → charCodeAt range check →
  slice -1) rather than introducing a code-point-aware loop:
  three byte-identical fixes across `@muse/shared` /
  `@muse/agent-core` keep the convention single-shaped, which
  is exactly the drift the next near-variant would introduce.
- Extended the existing describe rather than adding a new
  test file: the three prior `sanitizeFollowupSummary`
  assertions stay co-located with the new surrogate clause,
  and the module test surface is already well-shaped at
  `followup-capture-hook.test.ts`.
- Iteration 500 — milestone-shaped intentionally: a real
  correctness fix on a JARVIS-visible path (followup notices),
  mutation-proven, byte-identical for clean inputs. Not a
  no-op marker.
