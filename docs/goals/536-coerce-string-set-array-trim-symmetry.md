# 536 — `coerceStringSet`'s array branch trims and dedups like the csv branch (sibling-asymmetry within the same function)

## Why

`apps/api/src/compat-parsers.ts:51` defines `coerceStringSet` —
used by the OpenAI-compat MCP proxy routes to normalise
allow-list arrays like `allowedBitbucketRepositories`,
`allowedConfluenceSpaceKeys`, `allowedJiraProjectKeys`,
`allowedSourceNames` (lines 177-180 of `compat-mcp-proxy.ts`).

The function had two branches with **inconsistent semantics**:

```ts
// Array branch (line 53): filter keeps items if trim is non-empty
// but does NOT actually trim them before dedup.
if (Array.isArray(value)) {
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

// CSV-string branch (line 57): trims each item BEFORE dedup.
return typeof value === "string"
  ? [...new Set(value.split(",").map((item) => item.trim()).filter((item) => item.length > 0))]
  : [];
```

Concrete asymmetry. Two clients sending the same intent in the
two supported shapes produce different normalised sets:

- `value = "alpha, beta, alpha"` (CSV) → `["alpha", "beta"]` (deduped)
- `value = ["alpha", " beta ", "  alpha  "]` (array) →
  `["alpha", " beta ", "  alpha  "]` (NOT deduped — `"alpha"` and
  `"  alpha  "` are distinct strings under `Set`)

The allow-list then enforces three "different" entries that are
semantically the same. Worse: a downstream `Set.has("alpha")`
check would match the clean `"alpha"` but not `"  alpha  "`,
leading to surprising allow-list misses.

Same sibling-asymmetry defect class as goals 432 / 443 / 457 /
461 / 464 / 466 / 472-476 / 490 / 497 / 528 / 529 / 533 / 534
— two paths through one function that should behave
identically but don't.

## Slice

- `apps/api/src/compat-parsers.ts` — restructured the array
  branch to trim each item BEFORE the non-empty filter:
  ```ts
  if (Array.isArray(value)) {
    return [...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    )];
  }
  ```
  Behaviour byte-identical for every clean array input (all
  items already trimmed). Only the array path's whitespace
  handling now matches the csv path — same trim, same dedup,
  same Set output.
- `apps/api/test/compat-parsers.test.ts` — added one new
  `describe(...)` block with 4 focused tests:
  - csv path trims + dedups (baseline / regression pin)
  - non-string non-array input → `[]` (pre-existing contract)
  - array path trims + dedups (THE defect this iteration closes)
  - array path drops non-string entries silently
    (`["alpha", 42, null, "beta", undefined, "  beta  "]` →
    `["alpha", "beta"]`)

## Verify

- New tests 4/4 green; full `@muse/api` suite green (241
  passed, +4 vs baseline 237, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the array
  branch to the pre-fix shape (filter checks `trim().length >
  0` but doesn't trim) makes 2 tests fail with the precise
  pre-fix symptoms — `expected [ Array(4) ] to deeply equal
  [ 'alpha', 'beta', 'gamma' ]` (the padded duplicate
  survives), `expected [ 'alpha', 'beta', '  beta  ' ] to
  deeply equal [ 'alpha', 'beta' ]` (different
  whitespace-padded strings counted as distinct Set
  members). Fix restored, suite back to 4 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure parser — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the OpenAI-compat MCP
  proxy allow-list normalisation, not the model loop.

## Status

Done. A client passing the same allow-list as either a CSV
string or a JSON array of strings now produces an identical
normalised set. The two-branch asymmetry within
`coerceStringSet` is closed.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry CLI/API
robustness `fix:` on the compat allow-list normaliser,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the CLI UX run (534 / 535) to a fresh
  API-side parser asymmetry. Productive variation; the
  underlying defect class (two paths through one function
  with inconsistent semantics) is well-trodden ground but
  on a new function.
- Used `filter(string) → map(trim) → filter(non-empty)`
  rather than restructuring inline with type guards: the
  three-stage shape makes the contract explicit (string
  guard → normalise → drop empty). Mirrors the csv branch
  at line 57 byte-for-byte.
- Did NOT change the csv branch — it already trims +
  dedups correctly. The fix is purely about bringing the
  array branch up to the csv branch's contract.
- Added a 4th test for non-string array entries (silently
  dropped) to pin the existing tolerance behaviour: an
  array containing non-strings is a soft input contract,
  not a hard error.
- The mutation reverts the 6-line array-branch rewrite to
  its pre-fix shape; the 2 RED test failures reproduce the
  pre-fix observable byte-for-byte — duplicates survive,
  padded entries become distinct Set members.
