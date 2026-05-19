# 468 — chat-REPL slash typo gets a "did you mean" suggestion (parity with the top-level CLI)

## Why

The top-level CLI already turns a mistyped command into a
recoverable hint: `muse statu` →
`error: unknown command 'statu' / Did you mean 'muse status'?`
(`program.ts` unknown-subcommand action over the tested
`closestCommandName`). The **interactive chat REPL** — the
JARVIS-style conductor's primary conversational surface — did
not: any unrecognised slash command fell through to a flat
`(unknown command: /histroy — try /help)` with **no suggestion**,
even for a one-character typo of a real command. A user mid-chat
who fat-fingers `/histroy`, `/rememer`, `/persoanl` got no
recovery path beyond re-reading the whole `/help` list.

`closest-command.ts`'s own module docstring explicitly anticipates
this: *"can be reused by other Muse surfaces that need fuzzy
match"*. The chat REPL is exactly that surface, and the
inconsistency (CLI helps, REPL doesn't) is a concrete ergonomic
gap on the highest-traffic interactive path. This is
deepening/polishing an existing feature using the codebase's own
design intent — not new surface, and a different area from the
recent timestamp/Date-rollover robustness siblings (Step 8).

`handleSlashCommand` had **zero direct test coverage** (no test
file imported it; only indirect exercise via REPL paths), so the
unknown-command branch — and now the suggestion — is genuinely
uncovered, not redundant.

## Slice

- `apps/cli/src/chat-repl-slash.ts` — a stable `SLASH_COMMANDS`
  list (the 14 user-typeable slash names) + the `default:`
  branch now runs `closestCommandName(typed, SLASH_COMMANDS)`:
  on a close match it prints
  `(unknown command: /X — did you mean /Y? try /help for the
  list)`; with no close match it prints the **byte-identical**
  old `(unknown command: /X — try /help)` (zero regression to
  existing behaviour, and no random-looking guess — same
  no-false-suggestion contract `closestCommandName` already
  enforces for the CLI).
- `apps/cli/src/chat-repl-slash.test.ts` — first direct test of
  `handleSlashCommand`: a typo gets the right suggestion
  (`/histroy`→`/history`, `/rememer`→`/remember`); garbage
  (`/zzzzzzzz`) gets NO guess and the unchanged message; a known
  command (`/help`) still dispatches (no regression to the
  switch).

## Verify

- New test 4/4 green; full `@muse/cli` suite green (753 in
  `pnpm check`, +4 new, 0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `default:` branch to the old single line makes exactly the two
  "did you mean" tests fail with the precise pre-fix symptom
  (`expected '(unknown command: /histroy — try /help)…' to
  contain 'did you mean /history?'`) while the no-guess and
  no-regression tests stay green; fix restored, suite back to
  green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure local string logic (`closestCommandName` is a pure
  helper) — no LLM / model request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A mistyped slash command in `muse chat` now gets the same
"did you mean /X?" recovery the top-level CLI has had, so the
conductor's primary interactive surface no longer silently
strands a one-typo-away user. The `closest-command.ts` fuzzy
helper now serves the second surface its own docstring named.
Behaviour is byte-identical whenever no command is close, so no
existing flow regresses.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a CLI-ergonomics consistency `feat:`
polishing an existing feature, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Reused `closestCommandName` rather than a second fuzzy
  implementation: the helper is already tested, already tuned
  (length-aware cap, no-false-suggestion), and its docstring
  explicitly scopes it for cross-surface reuse — a near-variant
  here would be exactly the drift the single-source helper
  prevents.
- Kept the no-match output byte-identical to the prior message
  so the change is purely additive (a suggestion when one
  exists) — zero risk to any existing REPL test or muscle
  memory; only the close-match case is new.
- Scoped to the REPL surface only (did not also rewrite the
  unrelated `Goal 099` source-comment markers in
  `closest-command.ts` / `program.ts`): the user's standing
  constraint is tightest-scope / one coherent change, and the
  comment-marker sweep is a separate tracked backlog item — not
  folded in here to keep the diff coherent.
