# 419 — `muse remind` validates `<when>` before dispatch in both modes

## Why

CLI ergonomics / error-UX consistency deepening of an existing
user-facing feature (a deliberate change of flavour after a long
run of pure-function bug-fixes; `muse remind` is a core JARVIS
surface). Also closes a real test gap: there was **no
`commands-remind.test.ts`** — the command was only exercised
indirectly via `program.test.ts`, despite
`.claude/rules/cli-product.md` requiring a unit test for the
command parser.

`muse remind add` resolved `<when>` with `parseReminderDueAt`
only inside the `--local` branch. In the default (remote) path it
sent the raw `when` straight to `POST /api/reminders` with **no
client-side validation**. So the *same* bad input behaved
inconsistently:

- `muse remind --local "blah" "buy milk"` → immediate, actionable
  error: *"dueAt must be an ISO-8601 timestamp or a supported
  relative phrase (got "blah"). Examples: …"*.
- `muse remind "blah" "buy milk"` (remote) → a network round-trip,
  then whatever generic error the API surfaces — a worse,
  inconsistent experience for identical input.

The REST route (`apps/api/src/reminders-routes.ts`) uses the
**same** `parseReminderDueAt`, so client-side pre-validation can
never reject anything the server would have accepted — it is
purely a fail-fast/UX win, and it mirrors this file's own
established pattern ("Throws before dispatch so a typo'd --status
doesn't return a silently-wrong list").

## Slice

- `apps/cli/src/commands-remind.ts` — hoist the
  `parseReminderDueAt(when)` validation above the
  `if (options.local)` split so a bad `<when>` throws the
  identical actionable error in BOTH modes, before any API call.
  Remote mode still sends the **raw** `when` (`body.dueAt = when`)
  so the server remains the resolution authority — no semantic
  change for valid input, only the fail-fast added. (Renamed the
  local binding to `resolvedDueAt` to avoid colliding with the
  existing output-section `dueAt`.)
- `apps/cli/src/commands-remind.test.ts` (new) — harness with a
  recording fake `apiRequest`: remote-mode invalid `<when>` →
  actionable error AND zero API calls; remote-mode valid `<when>`
  → API called once with the raw phrase preserved; local-mode
  invalid → same error. Fails on the pre-fix code (remote invalid
  reached `apiRequest`).

## Verify

- `@muse/cli` commands-remind.test.ts 3/3 (new file); full
  `@muse/cli` suite green (66 files / 720, +3); tsc strict (cli)
  clean.
- `pnpm check` EXIT=0, every workspace green (api 194, cli 723,
  …); `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean.
- CLI-flow + deterministic pure-parser change verified with
  fixtures and a fake `apiRequest`; not a real model
  request/response path — no `smoke:live` applies.

## Status

Done. `muse remind <bad-when> …` now fails fast with the same
example-bearing error whether or not `--local` is set, and never
makes a doomed API round-trip — consistent, faster, friendlier;
and the command finally has direct command-parser test coverage.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is an ergonomics/consistency + test-coverage
deepening of an existing feature, recorded honestly as a
`fix(cli):` change with this backlog row — not a false metric.

## Decisions

- Kept remote mode sending the raw phrase (not the
  client-resolved ISO): switching the resolution authority to the
  client would be a semantic change (client vs server clock/TZ)
  outside this goal's scope. The fix is strictly additive
  (validate-then-dispatch), so valid input is byte-identical to
  before.
- Did not bundle the analogous `muse tasks --due` path: same
  potential gap, but a separate command — a tight follow-up if
  judged worthwhile, not scope-crept in here.
