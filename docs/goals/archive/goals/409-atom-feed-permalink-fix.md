# 409 — Fix Atom feed permalink selection (`muse feeds`)

## Why

Deepening/polishing an existing ambient feature (RSS/Atom feeds,
goal 092), a different axis from the recent
briefing/objectives/CLI-autonomy cluster.

`toAtomEntry` in `apps/cli/src/feeds-store.ts` selected an entry's
link with `linkRaw[0]["@_href"]` — blindly the FIRST `<link>`. But
per RFC 4287 §4.2.7.2 an Atom entry routinely carries several
`<link>` elements:

- `rel="alternate"` (or no `rel`, which the RFC mandates be read
  as `alternate`) — the human-readable **permalink**;
- `rel="self"` / `rel="edit"` / `rel="enclosure"` — the feed XML,
  the editing API, or an asset.

Many real feeds (and most Atom-publishing frameworks) emit
`<link rel="self">` first. The old code therefore recorded the
feed's own `.xml` URL (or an API endpoint) as the article link, so
`muse feeds` showed/opened the wrong URL — an observable
correctness bug in a shipped feature.

Compounding it: there was **no `feeds-store.test.ts`** at all.
`parseFeedBody` / `toAtomEntry` / `readScalar` had zero direct
unit coverage despite the module docstring explicitly claiming
"Pure (string in, array out) so a unit test can pin the format
detection" — exactly the implicit-only coverage
`.claude/rules/testing.md` forbids, which is why the bug shipped
unnoticed.

## Slice

- `apps/cli/src/feeds-store.ts` — replace the `linkRaw[0]` logic
  with `pickAtomLinkHref`: normalise the `<link>`(s) to candidates,
  treat a missing `rel` as `alternate` (RFC default), return the
  first `alternate` href; only if none exists fall back to the
  first href (best effort — a malformed feed must not drop the
  entry). String-form `link` still passes through unchanged.
- `apps/cli/src/feeds-store.test.ts` (new) — direct
  `parseFeedBody` coverage: RSS id-fallback + drop-untitled; Atom
  **rel=self-listed-first → picks alternate** (the regression that
  fails on the old code), rel-less = alternate, no-alternate
  fallback, `<updated>`/`<summary>` precedence; malformed XML /
  non-feed root / empty → `[]`; `{#text}` + entity decode.
- Removed three forbidden `Goal NNN —` markers from the
  docstrings in the parser region being edited (rides inside the
  fix; not a standalone comment sweep — the remaining markers in
  untouched merge/filter functions are deliberately left for a
  future scoped pass).

## Verify

- New test: `@muse/cli` feeds-store.test.ts 8/8 (the
  self-link-first case fails on the pre-fix code, passes after).
- `@muse/cli` full suite 64 files / 709 tests green (was 63/701)
  — `commands-feeds.test.ts` and all others unaffected; tsc strict
  (apps/cli) clean; `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean.
- Pure XML→array parser, single package, no shared-core boundary,
  no request/response (LLM) path — narrowest proportionate gate
  per `.claude/rules/testing.md`; no `smoke:live` applies.

## Status

Done. `muse feeds` now records the correct article permalink for
Atom feeds that order their links self-first (the common case),
and the pure parser finally has the direct regression coverage the
module always claimed.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a robustness fix + missing-coverage close on
an existing feature, recorded honestly as a `fix(cli):` change
with this backlog row — not a false metric.

## Decisions

- Fixed only the Atom link selection + added focused
  `parseFeedBody` coverage; did NOT expand the test to
  merge/filter/compare exports this iteration (they are
  indirectly exercised and unchanged — bundling them would be
  scope creep against the tight-scope rule). Direct coverage for
  those remains a legitimate future testing-rule slice.
- Fallback-to-first-href (not entry-drop) on a no-`alternate`
  malformed feed: a degraded link beats losing the item from the
  ambient picture — same conservative posture as the rest of the
  tolerant feed path.
