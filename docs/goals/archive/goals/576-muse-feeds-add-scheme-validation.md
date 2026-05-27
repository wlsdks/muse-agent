# 576 — `muse feeds add <url>` validates URL scheme upfront so the error message names the contract instead of bubbling fetch()'s "Invalid URL"

## Why

Step-8 redirect onto error-UX completeness on `muse feeds
add`. The command's description explicitly states the
contract:

> Register a new feed; fetches once on add.
> `<url>` — RSS / Atom feed URL (http(s):// or file://)

But the pre-fix validation only checked `trimmedUrl.length
=== 0`. Anything else fell through to `loadFeedBody`, which
on a non-URL input (`muse feeds add not-a-url`) tripped
`fetch("not-a-url")`'s internals with:

```
muse feeds add: initial fetch failed: TypeError: Invalid URL
```

The error names the symptom (`fetch failed`) but not the
actual contract violation (the URL must start with
`http://`, `https://`, or `file://`). Users see `Invalid URL`
and don't immediately know to add the scheme prefix.

Same defect class as goal 564's `muse vision` 404-hint
extraction — actionable error UX on a CLI command that
already documents a closed contract but doesn't enforce
it upfront.

## Slice

- `apps/cli/src/commands-feeds.ts` — added an up-front
  scheme regex gate immediately after the empty-check.
  `/^(?:https?:\/\/|file:\/\/)/iu` matches the documented
  schemes (case-insensitive so `HTTPS://example.com/feed`
  also passes through unchanged; downstream `loadFeedBody`
  uses case-sensitive `startsWith` for the file-path
  branch, so the strict-lowercase path still works
  identically). On reject, stderr says `URL must start
  with http://, https://, or file:// (got '<value>')` and
  the action exits 1.
- `apps/cli/src/commands-feeds.test.ts` — added one
  `it(...)` covering: `not-a-url` (bare junk) →
  rejected with the contract message, fetch's generic
  error doesn't leak through; `ftp://example.com/feed`
  (wrong scheme) → rejected; store stays empty after
  both rejections.

## Verify

- New `it(...)` green; full `@muse/cli` suite green (1029
  passed, +2 vs baseline 1027, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the
  scheme regex gate makes the new test fail with the
  exact pre-fix symptom — `expected stderr to contain
  "URL must start with http://, https://, or file://":
  the error must name the http:// / file:// contract,
  not the downstream fetch failure`. Fix restored, suite
  back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 249
  passed, apps/cli 1029 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the three intended files.
- Pure CLI input validator — no LLM request-response
  wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9). The defended
  path is `muse feeds add` user input, not the model
  loop.

## Status

Done. The `muse feeds add` command's documented contract
(`http(s):// or file://`) is now enforced upfront with an
actionable error. A future user typing `muse feeds add
not-a-url` sees the actual contract violation, not
fetch's internals.

A future grep for CLI commands that document a closed
URL/scheme contract but don't enforce it upfront could
surface more candidates; deferred to keep scope tight.

No CAPABILITIES line / no OUTWARD-TARGETS flip: an
error-UX hardening on the existing `muse feeds add`
surface, recorded honestly with this backlog row — not a
false metric.

## Decisions

- Regex `/^(?:https?:\/\/|file:\/\/)/iu` matches all four
  documented schemes (http, https, file) case-
  insensitively. The case-insensitive flag is defensive
  — RFC says schemes are case-insensitive in principle,
  even if `HTTP://` is rare in practice. Matches the
  shape goal-538 used for `--id` trim symmetry within
  the same command file.
- Did NOT add ftp/data/etc. — the description names
  exactly three schemes, so anything else is contract
  violation. Adding support is a feature change, not a
  validation fix.
- Did NOT do scheme normalisation (e.g. force-lowercase
  the URL). Reason: `slugifyUrl` and downstream
  `loadFeedBody` handle the original casing fine; the
  user's choice of scheme casing is theirs to keep.
- The mutation reverts to the pre-fix shape (no scheme
  guard, only the empty-check). Smallest delta; surgical
  proof that the scheme gate is the load-bearing change.
- Tests cover TWO branches (bare-junk + wrong-scheme)
  plus the store-stays-empty assertion. The wrong-scheme
  case (`ftp://`) specifically pins the contract — only
  the three documented schemes pass; everything else is
  rejected uniformly with the same message.
- Step-8 sub-defect-class check: actionable error UX
  completeness on a CLI command's documented contract is
  distinct from the recent comparator-determinism (574),
  did-you-mean (575), stdin ergonomics (573), strict-
  parse (570/571/572). Fresh defect-class slot.
