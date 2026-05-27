# 548 — `defaultIndexPath` (notes-rag) + `aggregateActivitySignals` home resolver reject empty `HOME=` (goal-547 sibling sweep)

## Why

A grep for `process.env.HOME ?? "~"` turned up two more sites
unfixed after the goal-547 sweep:

```ts
// apps/cli/src/commands-notes-rag.ts:62
function defaultIndexPath(): string {
  const home = process.env.HOME ?? "~";
  return pathJoin(home, ".muse", "notes-index.json");
}

// packages/memory/src/pattern-signals.ts:81 (aggregateActivitySignals body)
const home = options.homeDir ?? process.env.HOME ?? "~";
```

Same empty-env-shadow defect class as goals 478/481/482/483/488/
495/503/505/520/521/528/529/532/539/540/547. `HOME=""` → `""` →
either:

- `pathJoin("", ".muse", "notes-index.json")` →
  `".muse/notes-index.json"` (relative path under CWD — `muse
  notes-rag` writes/reads the index in whatever directory the
  operator invoked from)
- `path.join("", ".muse", "activity.jsonl")` /
  `.../"tasks.json"` / `.../"notes"` — the activity aggregator
  reads from CWD too, silently mis-attributing whose activity
  belongs to whom

The `pattern-signals.ts` site has an extra wrinkle: it accepts
an explicit `options.homeDir` override that should also be
trimmed (so `aggregateActivitySignals({ homeDir: "   " })`
falls through to env/homedir instead of resolving to `""`).

## Slice

- `apps/cli/src/commands-notes-rag.ts` — added `homedir` import;
  rewrote `defaultIndexPath` to mirror goal-547's `resolveHome`
  shape byte-for-byte (trim env → fall through to `homedir()` →
  throw on both-empty); promoted to `export` for direct test
  coverage.
- `packages/memory/src/pattern-signals.ts` — added `homedir`
  import; extracted a new `resolveAggregatorHome(explicit)`
  exported helper that trims the explicit override first, then
  env, then `homedir()`. Wired into `aggregateActivitySignals`
  in place of the lenient `?.homeDir ?? ?.HOME ?? "~"` chain.
- `apps/cli/src/commands-notes-rag.test.ts` — added one new
  `describe(...)` block with 2 focused tests (happy HOME path +
  whitespace-only HOME falls through).
- `packages/memory/test/pattern-signals.test.ts` — added one
  new `describe(...)` block with 3 tests covering all three
  precedence levels (explicit / env / homedir).

## Verify

- New tests 5/5 green; full `@muse/cli` suite green (967 passed,
  +4 vs baseline 963, 0 failed); full `@muse/memory` suite green
  (180 passed, +3 vs baseline 177, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `resolveAggregatorHome` to a lenient `explicit ?? process.env.
  HOME ?? "~"` produces 3 RED tests with the precise pre-fix
  symptoms — `expected '  /trimmed  ' to be '/trimmed'` (no
  trim of explicit), `expected '' to be '/env/home'` (empty
  explicit string leaks through `??`), `"   " not to match
  /^\s/u` (whitespace HOME leaks through). Fix restored, suite
  back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status` shows
  only the four intended files.
- Pure path resolvers — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended paths are `muse notes-rag` index
  + `muse routine` activity aggregator, not the model loop.

## Status

Done. The empty-env-shadow convention now covers EVERY
`process.env.HOME ?? "~"` / `?.trim() ??` resolver I could
find in the codebase:

- `defaultCredentialPath` (495)
- `defaultConfigPath` (505)
- `approvalsPath` / `trustPath` (539)
- `jobsDir` / `MUSE_NOTES_DIR` (540)
- `lastChatHistoryPath` / `activityLogPath` (547)
- `defaultIndexPath` / `aggregateActivitySignals` home (this
  goal)

A future grep for `HOME ?? "~"` or `HOME?.trim() ??` should now
return zero hits; if a new file adds one, the convention is
clear and `resolveAggregatorHome`-style helpers are local
templates.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; an empty-env-shadow `fix:` on
the two remaining HOME-resolving path resolvers, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Step-8 continuation from goal 547 onto the last two sibling
  sites — completes the cross-codebase empty-HOME sweep.
- The `pattern-signals.ts` site has THREE precedence levels
  (explicit / env / homedir); the helper handles all three
  with the same trim+nonempty check. Mirrors goal 495's
  `defaultCredentialPath` which also takes an explicit
  override.
- Promoted both `defaultIndexPath` and `resolveAggregatorHome`
  to `export` for direct testing. Pre-fix both were internal
  helpers with no direct coverage. Same widening pattern as
  goals 539/540/547.
- The mutation reverts `resolveAggregatorHome` (one of two
  identical fixes) — the `defaultIndexPath` shape is byte-
  identical to goal 505 / 547 / 540 helpers and would mutate
  identically. Cross-package convention is to test one
  representative.
- Inlined the same body twice for the two helpers rather than
  lifting a `@muse/shared` `resolveHome()`: every file's
  helper has slightly different details (the message, whether
  it takes an explicit override, whether it throws or returns
  undefined). Cross-package coupling for a 6-line helper
  would invite drift; the inline convention is now the
  six-site standard.
