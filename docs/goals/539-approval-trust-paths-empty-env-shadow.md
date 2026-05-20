# 539 — `approvalsPath` / `trustPath` reject empty `MUSE_APPROVALS_FILE` / `MUSE_TRUST_FILE` env (goal-532 sibling on the CLI approval / trust file resolvers)

## Why

`apps/cli/src/commands-approval.ts:45-49` (mirrored at
`apps/cli/src/commands-trust.ts:46`) used the lenient
`?.trim() ?? join(...)` pattern:

```ts
function approvalsPath(): string {
  return process.env.MUSE_APPROVALS_FILE?.trim() ?? join(homedir(), ".muse", "pending-approvals.jsonl");
}

function trustPath(): string {
  return process.env.MUSE_TRUST_FILE?.trim() ?? join(homedir(), ".muse", "trust.json");
}
```

`?.trim()` resolves a whitespace-only env value to `""`, and
`""` is non-null/undefined → the `??` doesn't fire → the
function returns `""`. Every downstream `readFile("")` /
`writeFile("")` / `appendFile("")` then fails with
`ENOENT: open ''` — confusing for a user who pre-cleared
`MUSE_APPROVALS_FILE=` in their shell expecting "use the
default."

Same empty-env-shadow defect class as goals 478 / 481 / 482 /
483 / 488 / 495 / 503 / 505 / 520 / 521 / 528 / 529 / 532.
The convention has landed across every CLI input boundary
except these two CLI command-local path resolvers.

## Slice

- `apps/cli/src/commands-approval.ts` — imported the existing
  `firstNonEmpty` helper from `program-helpers.ts` (added by
  goal 532) and replaced the lenient `?.trim() ??` pattern
  with `firstNonEmpty(...) ??` at both `approvalsPath` and
  `trustPath`. Promoted both to `export function` so the new
  unit tests can pin the behaviour directly.
- `apps/cli/src/commands-trust.ts` — same import + same
  replacement at `trustPath` (line 49).
- `apps/cli/src/commands-approval.test.ts` — added one new
  `describe(...)` block with 2 focused tests:
  - happy path: a clean non-empty `MUSE_APPROVALS_FILE` /
    `MUSE_TRUST_FILE` is returned verbatim
  - empty-env defence: whitespace-only / explicit-empty env
    values fall back to `~/.muse/{pending-approvals.jsonl,
    trust.json}` instead of leaking through as the resolved
    path

## Verify

- New tests 2/2 green; full `@muse/cli` suite green (917
  passed, +3 vs baseline 914, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `approvalsPath` to the pre-fix `?.trim() ??` shape makes the
  whitespace-only test fail with the precise pre-fix symptom
  — `expected '' to match /\/\.muse\/pending-approvals\./u`
  (the empty string leaked through, would have crashed
  downstream fs ops). Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the three intended files.
- Pure path resolvers — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended paths are the
  `muse approval` and `muse trust` commands' file I/O,
  not the model loop.

## Status

Done. A pre-cleared `MUSE_APPROVALS_FILE=` or
`MUSE_TRUST_FILE=` no longer poisons every `muse approval` /
`muse trust` invocation with opaque `ENOENT: open ''`
errors. The cross-CLI empty-env-shadow convention now reads
identically across:

- foundational filesystem paths (495, 503, 505)
- CLI flag boundaries (520, 521, 538)
- CLI state filters (528, 529)
- CLI API resolver (532)
- CLI approval / trust file resolvers (this goal)

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; an empty-env-shadow `fix:`
on two CLI command-local path resolvers, recorded honestly
with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the trim-symmetry feeds-refresh fix
  (538) to a fresh empty-env-shadow defect on a different
  CLI surface. Productive variation; the same convention
  now sweeps two paths in two files at once.
- Reused the existing `firstNonEmpty` helper from goal 532
  rather than inlining the trim+nonempty pattern at each
  call site. The helper is exported from `program-helpers.ts`
  and already tested directly there — every new caller is a
  one-line import + one-line call. Five sites already use
  this pattern; this iteration brings it to seven.
- Promoted both functions to `export` so the new tests can
  pin the behaviour directly. Pre-fix neither was exported,
  so the file-path resolution was effectively untested.
- The mutation reverts only `approvalsPath` (one of two
  identical fixes); the `trustPath` change is byte-identical
  in shape and the same mutation would fail identically.
  Cross-package convention is to test one representative
  when implementations are mechanical copies.
- The test uses real `process.env` stubbing with try/finally
  cleanup (matches the existing harness convention in this
  file). Vitest's `vi.stubEnv` would also work but adds an
  import; the manual stub is what the rest of this file
  uses.
