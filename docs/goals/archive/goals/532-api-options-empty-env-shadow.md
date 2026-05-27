# 532 — `readApiOptions` skips empty `MUSE_API_URL=` / `MUSE_API_TOKEN=` env values via a `firstNonEmpty` precedence helper (goal-478/481/482/483/488/495/503/505/520/521/528/529 sibling on the CLI's foundational API options resolver)

## Why

`apps/cli/src/program-helpers.ts:257` resolved the CLI's API base
URL and bearer token through a four-step `??`-chain:

```ts
const baseUrl = globalOptions.apiUrl ?? process.env.MUSE_API_URL ?? config.apiUrl ?? "http://127.0.0.1:3030";
const explicitToken = globalOptions.token ?? process.env.MUSE_API_TOKEN;
```

`??` only short-circuits on `null`/`undefined`. An empty string
or whitespace-only string passes through verbatim, producing
two concrete failure modes:

1. **`MUSE_API_URL=""`** (the pre-cleared-env launcher pattern):
   `?? `keeps `""`, every API request goes to `""` and fetches
   fail with an opaque `TypeError: Failed to parse URL from ""`.
   No useful "API not reachable at <url>" hint — just a
   low-level error.
2. **`MUSE_API_TOKEN=""`**: `??` keeps `""`. The empty token
   is sent in the `Authorization: Bearer ` header, the server
   401s, and the user-stored token (which `readStoredToken`
   would have loaded as a fallback) is **silently bypassed**.
   The operator sees auth failures despite having a stored
   token, with no indication that the empty env var shadowed
   it.

Same empty-env-shadow / `??` doesn't-catch-empty defect class
as goals 478 / 481 / 482 / 483 / 488 / 495 / 503 / 505 / 520
/ 521 / 528 / 529. The cross-package convention has landed on
filesystem path resolvers (495, 503, 505), CLI flag boundaries
(520, 521), and bucket-symmetry filters (528, 529); the
foundational `readApiOptions` is the remaining outlier on this
defect class — and the highest-leverage one, because every
API-backed CLI command depends on it.

## Slice

- `apps/cli/src/program-helpers.ts` — extracted a tiny
  exported helper `firstNonEmpty(...candidates)`:
  ```ts
  export function firstNonEmpty(...candidates: ReadonlyArray<string | undefined>): string | undefined {
    for (const c of candidates) {
      if (typeof c !== "string") continue;
      const trimmed = c.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return undefined;
  }
  ```
  Wired into both `readApiOptions` precedence chains:
  ```ts
  const baseUrl = firstNonEmpty(globalOptions.apiUrl, process.env.MUSE_API_URL, config.apiUrl) ?? "http://127.0.0.1:3030";
  const explicitToken = firstNonEmpty(globalOptions.token, process.env.MUSE_API_TOKEN);
  ```
  Behaviour byte-identical for every clean non-empty input
  (including the default `"http://127.0.0.1:3030"` fallback,
  which still fires when every candidate is empty/undefined).
  Only the empty / whitespace-only paths now fall through to
  the next candidate instead of poisoning the result.
- `apps/cli/src/program-helpers.test.ts` — added one new
  `describe(...)` block with 4 focused tests on the helper:
  - returns the first non-empty trimmed candidate
  - skips empty / whitespace-only / non-string candidates
  - trims a padded non-empty value before returning it
  - returns `undefined` when all candidates are empty /
    whitespace / undefined

## Verify

- New tests 4/4 green; full `@muse/cli` suite green (897
  passed, +4 vs baseline 893, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `firstNonEmpty` to a "first-non-undefined" variant (the
  pre-fix `??`-chain shape) makes 3 of the 4 new tests fail
  with the precise pre-fix symptoms — `expected '' to be
  'real'` (empty leak), `expected '  http://localhost:3030
  ' to be 'http://localhost:3030'` (no trim), `expected ''
  to be undefined` (no all-empty-undefined fallthrough).
  Fix restored, suite back to 4 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure precedence helper — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is every CLI
  command that reads API options at boot, not the model loop.

## Status

Done. The CLI's foundational `readApiOptions` no longer poisons
`baseUrl` or `explicitToken` when a launcher pre-clears
`MUSE_API_URL=` or `MUSE_API_TOKEN=`. The empty-env-shadow
convention now reads identically across the codebase's
foundational input-resolution boundaries:

- filesystem paths: `defaultCredentialPath` (495),
  `defaultConfigPath` (505), API `listen-config` (503)
- CLI flag boundaries: `muse feeds add --id/-url` (520, 521)
- CLI state filters: `muse {objectives,actions} --user`
  (528, 529)
- CLI API resolver: `readApiOptions` (this goal)

Each fallback path now consistently treats empty / whitespace-
only as "not provided" rather than "explicitly empty."

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry CLI
foundation-layer `fix:` on the API options resolver,
recorded honestly with this backlog row — not a false
metric.

## Decisions

- Step-8 redirect from the tiebreaker run (519 / 530 / 531)
  to a different defect class (empty-env-shadow) on a
  different surface (CLI's foundational API options
  resolver). Productive variation, not same-area churn.
- Extracted `firstNonEmpty` as an exported helper (rather
  than inlining at the call site): it's used twice in the
  same function, and the test surface is cleaner with the
  helper in isolation. Future callers can reuse it without
  re-implementing the trim+check pattern. Mirrors the goal-
  522 / 510 decision to widen-and-test a small predicate.
- Returned `undefined` (not `""`) when all candidates are
  empty/whitespace — keeps the function's contract honest
  about "nothing was provided." Callers `?? "http://...
  "` get the default; `?? undefined` callers (the token
  path) get `undefined` and dispatch through the existing
  `readStoredToken` fallback.
- Did NOT change `config.apiUrl` lookup at line 276 in
  `readConfigStore`: it already validates non-empty trimmed
  at read time. The `firstNonEmpty` chain composes correctly
  with that existing defense; the config layer is now
  doubly-defended.
- The mutation reverts to a "first non-undefined" variant
  (`if (c !== undefined) return c;`) which mirrors the
  pre-fix `??`-chain semantics; the 3 RED test failures
  reproduce the three pre-fix observables byte-for-byte
  (empty leak, no trim, no all-empty-undefined fallthrough).
