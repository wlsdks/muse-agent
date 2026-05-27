# 520 — `muse feeds add --id "   "` falls back to the slugified URL instead of silently inserting an empty-id feed (goal-478/481/482/483/488/495/503/505 sibling on the feeds-add input boundary)

## Why

`apps/cli/src/commands-feeds.ts:110` resolved the feed id with:

```ts
const id = (options.id ?? slugifyUrl(url)).trim();
```

`??` only short-circuits on `null`/`undefined`. If the user
passes `--id "   "` (whitespace-only — easy mistake from copy-
paste with trailing space, an empty shell variable expansion, or
hand-editing a script), the `??` keeps the whitespace string,
`.trim()` produces `""`, and the feed is silently registered
with **id = ""**.

The corrupt state then cascades:

- `muse feeds list` prints a tab-leading line: `\t1 entries\thttps://...`
- `muse feeds remove ""` is hard to type (quote-empty argument)
- `muse feeds refresh --id ""` requires the same gymnastics
- a follow-up `muse feeds add --id ""` collides on the
  "already exists" branch but reports `'.'.exists` with a blank
  id, confusing the operator further
- the `feeds.json` store now contains an entry with id="" that
  has to be hand-edited out

Same empty-env-shadow / `?? ` doesn't-catch-empty defect class
as goals 478 / 481 / 482 / 483 / 488 / 495 / 503 / 505. Those
goals fixed `HOME=""` / `PATH=""` / `MUSE_X=""` shadowing on
filesystem path resolvers; this is the same pattern on a CLI
positional/flag boundary. The user-intent is clear from the
`slugifyUrl(url)` fallback path — if the explicit id is unset
OR effectively unset, fall through to the URL-derived default.

## Slice

- `apps/cli/src/commands-feeds.ts` — replace:
  ```ts
  const id = (options.id ?? slugifyUrl(url)).trim();
  ```
  with the two-step trim-then-nonzero check:
  ```ts
  const trimmedExplicit = options.id?.trim() ?? "";
  const id = trimmedExplicit.length > 0 ? trimmedExplicit : slugifyUrl(url);
  ```
  Behaviour byte-identical for every clean non-empty `--id`
  (already trimmed before the comparison) — only the
  whitespace-only / undefined paths now fall through to
  `slugifyUrl(url)` instead of producing `""`.
- `apps/cli/src/commands-feeds.test.ts` — added one new
  `describe(...)` block with two tests:
  - `--id "   "` (whitespace-only) → falls back to slug, the
    follow-up `feeds list` output contains the slugified URL
    (and does NOT have an empty-id tab-leading line)
  - `--id "  custom-alias  "` (padded clean) → trimmed to
    `custom-alias` (preserves the existing trim contract)

  Both tests use a `file://` feed URL written to a temp file
  so the fetch path resolves locally without network IO.

## Verify

- New tests 2/2 green; full `@muse/cli` suite green (873
  passed, +3 vs baseline 870, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting back to
  the lenient `(options.id ?? slugifyUrl(url)).trim()` makes
  the whitespace-only test fail with the precise pre-fix
  symptom — `expected '\t1 entries\tfile:///var/folders/...'
  to contain 'var-folders-...-feed-xml'` (the `feeds list`
  output starts with `\t` because the registered feed has
  id="", proving the silent-empty insert). Fix restored,
  suite back to 2 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure flag-parser — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9).

## Status

Done. A `muse feeds add <url> --id "   "` no longer silently
registers a feed with id="" that's hard to remove or refresh.
The cross-CLI empty-env-shadow convention now reads
identically on the feeds-add flag boundary: an effectively-
unset value (whitespace-only) falls through to the documented
fallback (slugified URL) rather than producing a corrupt-but-
truthy id.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry CLI-input
robustness `fix:` on the `muse feeds add` command,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Pivot from the sort-tiebreaker class (goal 519) to the
  empty-env-shadow class on a different surface (CLI flag
  boundary instead of filesystem path resolver). Productive
  variation: same convention, distinct mechanism, fresh
  failure mode.
- The whitespace-only test asserts `stdout NOT matching ^\s\t`
  to pin the absence of the corrupt tab-leading "empty id"
  line, AND `stdout containing slugifyUrl(url)` to confirm
  the fallback fired. Both assertions are necessary: the
  absence proves there's no empty-id row; the presence proves
  the slug fallback path is wired.
- Kept the order `trim → check nonzero → slugifyUrl` rather
  than `slugifyUrl → trim → check`: when the explicit `--id`
  IS provided non-empty, we don't need to compute the slug
  (and the existing call sites elsewhere in the file rely on
  that ordering for performance — `slugifyUrl` does several
  regex passes).
- The mutation reverts to `(options.id ?? slugifyUrl(url)).
  trim()` exactly because that's the pre-fix code; the test
  failure (`\t1 entries\t...` tab-leading line) reproduces
  the pre-fix observable byte-for-byte.
- Did NOT add a similar fallback for `--name`: that field is
  free-form (it's the human-readable label, not a key); an
  empty `--name` should still be valid (just defaults to the
  id via `options.name ?? id`). Different semantics, no fix
  needed.
