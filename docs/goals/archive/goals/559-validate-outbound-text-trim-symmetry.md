# 559 — `validateOutboundMessage` rejects whitespace-only `text` (trim-symmetry sibling within one function)

## Why

`validateOutboundMessage` is the shared validator every outbound
messaging provider (Telegram, Slack, Discord, LINE, libnotify,
macOS notification, log) hits before talking to the platform
API. The pre-fix function had a within-function asymmetry:

```ts
// destination — trim-checked
if (... destination.trim().length === 0) { throw ... }

// text — bare length-checked
if (... text.length === 0) { throw ... }
```

A `text` of `"   "` / `"\n\t"` / `"  \n  "` passed validation
and flew out unchanged to the platform API. Recipients saw a
blank notification bubble (Telegram), an empty Slack post, a
Discord message with no visible body, or a libnotify alert
with title only. Same UX defect class goal 538
(`muse feeds refresh --id "  weather  "`) and goal 536
(`coerceStringSet` array branch trim) closed on different
surfaces.

The real-world trigger: any caller building `text` from
interpolation (`${maybeEmpty1} ${maybeEmpty2}`) can land on
whitespace-only output when every slot is empty. The
proactive notice loop and the situational briefing daemon
both do exactly this. Pre-fix they'd send a blank
notification; post-fix they get the validator error and can
log + skip.

## Slice

- `packages/messaging/src/validate.ts` — changed the `text`
  check from `message.text.length === 0` to
  `message.text.trim().length === 0`, matching the existing
  `destination` check shape byte-for-byte. The trim only
  applies to the empty-content check; the payload still
  flies out unchanged (e.g. an indented code block keeps
  its leading whitespace).
- `packages/messaging/test/messaging.test.ts` — added one
  `it(...)` covering both the new behaviour (whitespace
  text → reject) and a sibling assertion pinning the
  destination trim (whitespace destination → reject, so a
  future regression can't silently revert it). Also asserts
  the allowed case (`"  hello  "` → accepted; trim only
  gates the empty-check, doesn't mangle real content).

## Verify

- New `it(...)` green; full `@muse/messaging` suite green
  (173 passed, +1 vs baseline 172, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `text` check to bare `.length === 0` makes the new test
  fail with the precise pre-fix symptom — `text="   " must
  reject — not silently send a blank notification: expected
  [Function] to throw an error`. Fix restored, suite back
  to all green (173 passed).
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1000 passed, packages/messaging 173
  passed); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the three
  intended files.
- Pure validator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is every
  outbound messaging provider's `send()` call gate, not the
  model loop.

## Status

Done. The trim-symmetry convention now reaches every public
validation gate in `packages/messaging`:

- `destination` field — `.trim().length === 0` check
- `text` field — `.trim().length === 0` check (this goal)

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a within-function sibling-
asymmetry `fix:` on the shared messaging validator, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Trim only the empty-check, NOT the payload that flies out.
  Reason: a user's intentional message could include leading
  / trailing whitespace (a snippet of indented code, an
  ASCII-art prefix). The validator's job is "is there ANY
  content?", not "normalise content". Same shape goal 538
  used for feeds refresh.
- Did NOT trim the `MAX_TEXT_LENGTH` check. The 4096-char
  cap applies to the raw payload that flies out, so a
  string with 4097 chars (4096 content + 1 trailing space)
  is correctly rejected as oversized; trimming the cap
  check would let oversized payloads sneak past the cap
  with trailing whitespace. The pre-fix cap behaviour is
  correct; this iteration only fixes the empty-check
  asymmetry.
- Mutation reverts the within-function delta (one keyword:
  `.trim()`). Smallest possible mutation, surgical proof.
- The sibling destination assertion (`expect(() =>
  validate({ destination: "   ", text: "hi" })).toThrow(...
  )`) is included even though the destination side WAS
  already correct, so a future regression can't silently
  un-trim destination without the test catching it. The
  goal-181 / goal-546 pattern of "pin the existing
  invariant alongside the new one" applies.
- Step-8 sub-defect-class check: trim-symmetry is its own
  sub-cluster (goals 536 / 538 / this) — distinct from
  the comparator-determinism cluster (551 / 555 / 556),
  HOME-resolution (547-550), did-you-mean (543-545), and
  strict-parse (554). Within the broader "polish / UX
  hardening" theme but a different defect class from any
  of the recent 5 iterations.
