# 580 — `muse orchestrate run --mode` is case-insensitive and normalizes into the API body

## Why

Step-8 redirect from the comparator-determinism sweep (578/579)
onto a fresh defect class — case-sensitivity on a CLI enum flag
that ALSO rides into an API request body.

The CLI case-insensitivity convention (goals 568/569 on slash
sentinels, and the `assert*Input` helpers in
`commands-tasks.ts:48` / `commands-remind.ts:48` /
`commands-actions.ts:24` / `commands-recall.ts:141` /
`commands-history.ts:116`) is established: every enum flag
normalizes via `.trim().toLowerCase()` BEFORE the includes
check. `commands-orchestrate.ts:51` was the outlier:

```ts
// pre-fix
if (!ORCHESTRATE_MODES.includes(options.mode)) {
  // throws "did you mean 'sequential'?" — even on `--mode SEQUENTIAL`
  ...
}
...
writeOutput(io, await apiRequest(io, command, "/api/multi-agent/orchestrate", {
  message,
  mode: options.mode,  // ← raw casing flows to the server too
  ...
}));
```

Real-world impact:
1. `muse orchestrate run --mode SEQUENTIAL <msg>` previously
   threw `--mode must be 'sequential', 'parallel', or 'race'
   (got 'SEQUENTIAL') — did you mean 'sequential'?`. The user
   typed a valid value with reasonable capitalization and got
   a typo error.
2. Even if a user found a hand-rolled way to bypass the
   validation, `body.mode` would be sent as `"SEQUENTIAL"`
   verbatim — the server's downstream router (`MultiAgentOrchestrator`'s
   mode dispatch) almost certainly compares against lowercase
   constants, so the request would silently behave wrong on
   the server side.

## Slice

- `apps/cli/src/commands-orchestrate.ts:47-55` — normalized
  the mode via `.trim().toLowerCase()` BEFORE the includes
  check, mirroring the goal-568/569 / tasks-status / remind-
  status conventions. The error message still echoes the
  raw `options.mode` so the user sees what they typed; the
  closest-command suggestion now operates on the normalized
  value (consistent with how `closestCommandName` already
  lowercases candidates internally).
- `apps/cli/src/commands-orchestrate.ts:62-68` — request
  body now sends `mode` (the normalized value), not
  `options.mode` (raw). Removes the upstream-vs-downstream
  casing mismatch.
- `apps/cli/test/program.test.ts` — added one `it(...)`
  immediately after the existing "rejects unknown mode"
  test: captures the request body and asserts (a)
  `--mode PARALLEL` → 200 with `body.mode === "parallel"`;
  (b) `--mode '  Race  '` (mixed case + whitespace) →
  `body.mode === "race"`. The existing typo + empty-message
  test still passes because `bogus` doesn't normalize to a
  valid value.

## Verify

- New `it(...)` green; full `@muse/cli` suite green (1031
  passed, +1 vs baseline 1030, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  normalization to the bare `if (!ORCHESTRATE_MODES.
  includes(options.mode))` shape makes the `--mode
  PARALLEL` test fail — the command throws `--mode must
  be 'sequential', 'parallel', or 'race' (got 'PARALLEL')
   — did you mean 'parallel'?` before the request fires.
  Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api
  249 passed, apps/cli 1031 passed); `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the three intended files.
- Pure CLI validation / API-body normalization — no LLM
  request-response wire path actually invoked (the test
  stubs `fetch` to capture the body). `smoke:live` does
  not apply to this branch (the change is on the
  request-construction path; the actual orchestration
  ran in the existing goal-? tests). The defended path
  is `muse orchestrate run --mode <mixed>` upstream of
  the API call, not the model loop.

## Status

Done. Every CLI enum flag I can find now normalizes via
`.trim().toLowerCase()` before its `includes` / `has`
check, matching the cross-codebase convention. A future
grep for raw `.includes(options.<flag>)` on a literal
enum constant should return zero hits.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
case-insensitivity hardening on the existing `muse
orchestrate run` surface, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Normalize the value AND propagate the normalized value
  to the API body. Reason: the case-insensitivity has to
  reach the server. If we lowercased only on the
  validation gate and sent the raw value, the server
  would still see mixed casing and (depending on its
  matcher) either reject or behave wrong.
- The closest-command suggestion now operates on the
  normalized value. `closestCommandName` already
  lowercases both sides internally, so this is a no-op
  for correctness — but feeding it the normalized value
  is consistent with the surrounding `mode` usage.
- Error message still echoes `options.mode` (raw) so
  the user sees what they typed. Same pattern goal-568
  used: normalize internally, show original in errors.
- Did NOT change the `ORCHESTRATE_MODES` constant (still
  lowercase literals). The convention is "constants are
  lowercase, input gets normalized to match". Keeps the
  source of truth a single readonly array.
- Mutation reverts to the bare `options.mode` shape (the
  pre-fix). Smallest semantic delta — the new
  `mode = ...trim().toLowerCase()` line is the load-
  bearing change; the body now references `mode` instead
  of `options.mode`. Mutation reverts both back to the
  raw form.
- The test stubs `fetch` to capture the body — same
  shape goal-571's multi-agent test uses. Verifying the
  body shape end-to-end (not just the error) is the
  load-bearing assertion here; the validation gate is
  secondary.
- Step-8 sub-defect-class check: case-insensitivity on
  CLI enum flags is distinct from the recent comparator-
  determinism (578/579), error-UX (576), did-you-mean
  (575), persona ergonomics (577). The goal-568/569
  case-insensitivity sweep was on slash sentinels;
  this is on CLI flags. Fresh sub-class slot.
