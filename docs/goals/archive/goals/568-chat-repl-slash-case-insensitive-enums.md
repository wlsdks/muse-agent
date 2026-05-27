# 568 — chat-REPL `/tools` and `/persona` accept case-insensitive enum sentinels

## Why

Step-8 redirect onto a fresh defect class — case-sensitivity
on slash-command enum sentinels — distinct from the recent
sweep (comparator-determinism, did-you-mean, envelope-parity,
trim-symmetry, integer-overflow, validate-NaN, error-UX).

Two slash handlers in `chat-repl-slash.ts` did exact
case-sensitive string equality on enum-shaped args:

```ts
// /tools — pre-fix
if (arg === "on") { ... } else if (arg === "off") { ... }
//   typed `/tools ON` or `/tools Off` ⇒ falls through to usage echo
//   user can't tell whether the command broke or they typo'd

// /persona — pre-fix
const next = arg === "none" || arg === "off" || arg === "default" ? undefined : arg;
//   typed `/persona NONE` ⇒ stored as the literal persona name
//   "NONE" instead of clearing — a subtler trap because the user
//   sees `persona → NONE` and may not realise it's a literal
```

Every other CLI enum gate (search `--time`, remind `--status`,
tasks `--status`, history `--kind`, objectives `--kind`,
orchestrate `--mode`, actions `--result`, mcp config-add
`--transport`) normalises via `.trim().toLowerCase()` before
matching. The two REPL handlers were the asymmetric outliers.

The `/persona` defect was especially dangerous: a user who
intended to clear the persona by typing `NONE` (the usage
hint says lowercase, but reasonable Caps-Lock users wouldn't
think twice) instead got a persona named `NONE` activated,
silently swapping into an empty memory bucket — exactly the
goal-242 "dangling active id" trap on a different surface.

## Slice

- `apps/cli/src/chat-repl-slash.ts` — `case "tools"`
  normalises `arg.trim().toLowerCase()` before the
  `=== "on"` / `=== "off"` matches. `case "persona"`
  normalises into a `sentinel` local for the
  `none / off / default` cleared-persona check; the
  passthrough value (when not a sentinel) still uses the
  original `arg` so the persona name keeps the user's
  preferred casing.
- `apps/cli/src/chat-repl-slash.test.ts` — added two
  `describe(...)` blocks: `/tools — case-insensitive enum
  matching` (4 `it`s covering `ON`, `Off`, surrounding
  whitespace, unrelated input not silently flipping
  state) and `/persona — sentinel matching is
  case-insensitive` (3 `it`s covering `NONE` and `Default`
  clearing, and a plain `work` passing through with its
  casing intact). Widened the local harness type from
  `satisfies SlashContext` to `: SlashContext` so the
  `currentPersona` assignment in tests doesn't get the
  literal-undefined narrowing.

## Verify

- New `it(...)` blocks green; full `@muse/cli` suite green
  (1019 passed, +7 vs baseline 1012, 0 failed); tsc
  strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `case "tools"` block to the pre-fix case-sensitive
  comparison makes all four `/tools` tests fail
  simultaneously (3 reported failures + 1 implicit). The
  precise pre-fix symptom — `/tools ON` falls through to
  the usage echo and leaves `toolsDisabled` unchanged. Fix
  restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1019 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the three intended files.
- Pure REPL dispatcher — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the chat
  REPL slash dispatcher, not the model loop.

## Status

Done. The CLI enum-matching convention (`.trim().
toLowerCase()` before equality) now reaches the two
chat-REPL slash handlers that previously did exact-case
matching. A future grep for `arg === "[a-z]+"` inside
the slash dispatcher should return zero hits — every enum
match goes through the normalised local.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
convention-parity hardening on the chat-REPL surface,
recorded honestly with this backlog row — not a false
metric.

## Decisions

- Normalised the comparison input but preserved the
  original `arg` for the passthrough value in `/persona`.
  Reason: the sentinel set `{none, off, default}` is
  meta-syntax (clear the persona); a real persona name
  could legitimately be `Work-Q3` and the user expects
  that exact casing to round-trip through the user-key
  composer. The sentinel check is the only branch where
  case should be ignored.
- `/tools` arg now has its case stripped before display
  too (the echo lines `(tools on)` / `(tools off)` always
  match the normalized form). Reason: the echo is a
  status confirmation, not user input — uniform output
  is correct.
- Did NOT change the slash-dispatcher's case-handling for
  the command name (`cmd`). The dispatcher already
  lowercases the slash command (`/Reset` → `reset`)
  upstream — only the enum-arg matching was missing the
  normalisation.
- Mutation reverts the `/tools` case (one of two
  identical fixes). The `/persona` case has a
  byte-identical normalisation shape and would
  mutate-fail identically; cross-handler convention is
  to test one representative.
- The harness type widening (`satisfies SlashContext` →
  `: SlashContext`) was forced by the new tests' need to
  assign `currentPersona = "work"`; pre-fix `satisfies`
  narrowed the type to the literal `undefined`. Pure
  test-infrastructure widening with no behaviour impact
  on the existing tests (all 4 pre-existing tests pass
  identically).
- Step-8 sub-defect-class check: case-sensitivity on
  REPL enum matching is distinct from comparator-
  determinism (551/555/556), validate-NaN (562/563),
  envelope-parity (565/566/567), error-UX (564),
  trim-symmetry (559), integer-overflow (561), and the
  closest-command convention (567). Fresh defect-class
  slot.
