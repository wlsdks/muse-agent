# 521 — `muse feeds add` rejects a whitespace-only URL up front and trims a padded URL before persisting (goal-520 sibling on the feed-URL positional arg)

## Why

`apps/cli/src/commands-feeds.ts:107` accepted the positional
`<url>` arg verbatim, then forwarded it to
`loadFeedBody(url)`:

```ts
.action(async (url: string, options: …) => {
  …
  const body = await loadFeedBody(url);
  …
  feeds: [..., { id, url, name: …, lastFetchedAt: …, entries }]
});
```

Two related defects on the URL boundary, after goal 520
closed the `--id` boundary:

- **Whitespace-only URL** (`muse feeds add "   "`): the CLI
  silently forwarded `"   "` to `loadFeedBody`, which
  produced an opaque "initial fetch failed: TypeError: Invalid
  URL" error. The user gets a confusing low-level fetch message
  instead of a CLI-layer "feed URL must be non-empty" hint.
- **Padded URL** (`muse feeds add "  file://...xml  "`):
  forwarded as-is. The fetch path happened to work (whitespace
  trimmed by the URL constructor on some inputs), but the
  `feeds.json` store **persisted the padded form** — leading
  to a tab-leading `feeds list` line and an awkward
  `feeds remove "  file://..  "` requirement to clean up.

Both are sibling-asymmetry instances of goal 520's
whitespace-trim-then-fall-through pattern, here on the
positional arg instead of the optional flag.

## Slice

- `apps/cli/src/commands-feeds.ts` — added an up-front trim +
  non-empty guard on `url`, with an actionable error:
  ```ts
  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    io.stderr("muse feeds add: feed URL must be non-empty (http(s):// or file://)\n");
    process.exitCode = 1;
    return;
  }
  ```
  Then threaded `trimmedUrl` through `slugifyUrl(trimmedUrl)`,
  `loadFeedBody(trimmedUrl)`, and the persisted store entry
  `{ ..., url: trimmedUrl, ... }`. Behaviour byte-identical for
  every clean URL; only the empty / whitespace-only path now
  fails fast with a useful message, and the padded path
  persists the trimmed form.
- `apps/cli/src/commands-feeds.test.ts` — added two new tests
  to the existing `describe(...)` block:
  - whitespace-only URL → exit 1, stderr matches `feed URL must
    be non-empty`, store remains empty (`feeds list` reports
    `(no feeds...)`)
  - padded URL `"  file://...  "` → exit 0, `feeds list` shows
    the trimmed URL and does NOT contain the padded form
    (no leading two-space `  file://`)

## Verify

- New tests 2/2 green; full `@muse/cli` suite green (877
  passed, +4 vs baseline 873, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the guard
  to `const trimmedUrl = url;` (no trim, no early return)
  makes the whitespace-only test fail with the precise pre-
  fix symptom — `expected 'muse feeds add: initial fetch
  failed: …' to contain 'muse feeds add: feed URL must be
  non-…'` (the user gets the confusing low-level fetch error
  instead of the CLI-layer message). Every other test stays
  green. Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure CLI arg validation — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. `muse feeds add "   "` now fails fast with `muse feeds
add: feed URL must be non-empty (http(s):// or file://)`
instead of a confusing "initial fetch failed: Invalid URL".
`muse feeds add "  file://x  "` now persists the trimmed URL
instead of dragging the padding into the `feeds.json` store.
The trim-then-fall-through convention now reads identically
across both the `--id` flag (goal 520) and the URL
positional arg.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry CLI-input
robustness `fix:` on `muse feeds add`, recorded honestly with
this backlog row — not a false metric.

## Decisions

- Validated the URL **before** reading the feeds store: no
  point opening the file when the input is already known bad.
  Mirrors the goal-503 `resolveListenPort` early-return shape.
- The error message names the expected schemes (`http(s)://
  or file://`) — same convention as the `<url>` arg's own
  Commander description (`"RSS / Atom feed URL (http(s)://
  or file://)"`). The CLI error message echoes the flag help
  exactly, so a confused operator sees the same vocabulary on
  both sides.
- Persisted the trimmed URL (not the raw `url`) so a later
  `feeds list` doesn't show padding and `feeds remove
  <trimmedUrl>` works without quoting whitespace. A future
  audit-on-load could re-normalise legacy padded rows, but
  that's a separate concern; this fix only addresses new
  inserts.
- Did NOT add a full URL parser / schema validator: the
  iteration-loop's "right-sized: the necessary thing"
  principle. `loadFeedBody` already 4xxs on a malformed URL
  shape; this fix only catches the highest-frequency typo
  class (empty / whitespace-padded) at the boundary.
- Step-8 continuation from goal 520 onto the sibling
  positional-arg path of the same command. Two-iteration
  sweep on the same command is fine — the defect class is
  distinct from any of the previous five iterations
  (514-518 / 519), and `muse feeds add` is one cohesive
  surface where both flag-trim AND positional-trim need to
  read identically.
