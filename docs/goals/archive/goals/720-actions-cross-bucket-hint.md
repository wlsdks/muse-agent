# 720 — `muse actions` points at `--user all` when actions exist only under other buckets (so channel refusals aren't invisible)

## Why

719 made the channel-approval gate record refused remote tools to the
action log — but under a `provider:source` user bucket (e.g.
`telegram:42`), since that is the channel's memory scope. `muse actions`
defaults to `--user local`, so a user who refused a risky action over
Telegram and then ran a plain `muse actions` saw `No recorded actions.`
— as if nothing happened. The accountability surface was hiding the very
entries 719 added. `--user all` already exists, but nothing pointed the
user to it.

This continues the established 719 work (making remote refusals visible),
the autonomous-loop "deepen what exists" path.

## Slice

- `apps/cli/src/commands-actions.ts`: in the empty-result branch, when
  the scoped bucket is empty (`all.length === 0`) AND `--user` is not
  `all`, query the full log; if other buckets hold entries, append a hint
  naming up to three of them and suggesting `--user all`. A genuinely
  empty log still prints the exact `No recorded actions.` line, and a
  `--result` filter that merely empties a non-empty bucket does NOT
  trigger the hint (guarded on the *unfiltered* scoped count).

## Verify

- `@muse/cli` commands-actions.test.ts (1253 tests): empty `local` bucket
  with a `telegram:42` entry → message names `telegram:42` + `--user all`,
  and `--user all` surfaces the entry; fully-empty log → unchanged
  `No recorded actions.\n`; a `--result refused` view of a bucket that has
  only a `performed` entry → plain message, no mis-suggestion.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — pure CLI read-surface logic over
  the existing action log.

## Decisions

- **Guard the hint on the unfiltered scoped count** — suggesting
  `--user all` only makes sense when *this bucket* is truly empty; if the
  bucket has entries but a `--result` filter hid them, the right fix is a
  different filter, not another user, so the hint stays silent there.
- **Name the buckets, capped at three** — showing `telegram:42` etc. tells
  the user exactly where to look without flooding the line when many
  channels are active.
- **Preserve the exact empty string for a truly-empty log** — an existing
  test (and any scripts) rely on `No recorded actions.\n`; the hint is
  purely additive to the other-bucket case.
