# 627 — `readFeedsStore` normalises each surviving feed record's `entries` to an array (and `name` to the feed id when missing), so a hand-edited / migrated `~/.muse/feeds.json` carrying an `entries`-less feed no longer crashes `muse feeds list` on `feed.entries.length`

## Why

`apps/cli/src/feeds-store.ts:readFeedsStore` was tolerant about
the outer envelope (missing file → empty store, wrong version →
empty store, non-array `feeds` → empty store) but only validated
TWO fields of each surviving feed record:

```ts
const feeds = (candidate.feeds ?? []).filter((f) =>
  f && typeof f === "object" && typeof f.id === "string" && typeof f.url === "string"
);
return { version: FEEDS_STORE_SCHEMA_VERSION, feeds };
```

`FeedRecord` declares `entries: readonly FeedEntry[]` and
`name: string` as **required** — but the filter doesn't enforce
either. So the runtime type lies whenever:

- An older schema (or a pre-fetch registration) wrote a feed
  record without an `entries` field.
- A hand-edit of `~/.muse/feeds.json` added a feed with just
  `id` + `url`.
- A partial-write recovery (Node crash between writeFile and
  rename in a non-atomic writer) left a record without
  `entries`.
- An external tool / future migration set `entries: null` /
  `entries: 42` / `entries: "[]"` (the string form).

Then `feed.entries.length` — the exact expression at
`commands-feeds.ts:160` and `:170`, the bodies of both `muse
feeds list` and `muse feeds list --json` — crashes with:

```
TypeError: Cannot read properties of undefined (reading 'length')
```

This is a CLI-crashing defect on a code path the user has every
reason to invoke right after `muse feeds add` succeeds.
Similarly, `feed.name` reaches a `${feed.name}` template
literal where missing `name` would render the literal string
`undefined` to the user.

This iter's defect class — **tolerant-read normalises one level
deep but not the nested array / sibling string** — is fresh
against the recent window:
- 626: child-process stream error
- 625: strict env-parse
- 624: HTTP timeout
- 623: diagnostic classification
- 622: boolean spelling
- 621: test additions
- 620: graceful read recovery (whole-file `try/catch`, not field
  normalisation)
- 619: blank-keyword filter (constructor input, not file load)
- 618: memory cap

`readFeedsStore` is the ONLY load path for `~/.muse/feeds.json`;
fixing it once heals every downstream surface (`feeds list`,
`feeds list --json`, `feeds today`, `feeds remove`,
`feeds refresh`) at the same time.

## Slice

- `apps/cli/src/feeds-store.ts`:
  - After the `filter(...)` retains records with valid `id` +
    `url`, chain a `.map(normalizeFeedRecord)` that returns a
    `FeedRecord` with:
    - `entries: Array.isArray(raw.entries) ? raw.entries : []`
    - `name: typeof raw.name === "string" && raw.name.length > 0
      ? raw.name : raw.id`
  - Spread `...raw` first so `lastFetchedAt` and any forward-
    compat fields ride through unchanged.
  - Helper kept local (`normalizeFeedRecord`) rather than
    inlined so the contract is named and testable.
- `apps/cli/src/feeds-store.test.ts`:
  - Four new tests under a new `describe("readFeedsStore —
    tolerant-read normalises each feed's `entries` ...")` block.
    Tests write a real JSON file to a `mkdtemp` directory,
    call `readFeedsStore`, and assert the loaded shape.
    `afterEach` runs `rm(dir, { recursive: true, force: true
    })` so the tmp tree never leaks.
  - **Missing `entries`** — `{id, url, name}` only on disk;
    asserts `store.feeds[0].entries === []` AND that
    `() => store.feeds[0].entries.length` does NOT throw
    (the crash-bearing expression from `commands-feeds.ts`).
  - **Non-array `entries`** — three records with
    `entries: null` / `"not-an-array"` / `42`; asserts all
    three load with `entries: []`.
  - **Missing `name`** — `{id: "namelessfeed", url}`; asserts
    `feed.name === "namelessfeed"` (degrades to id, not the
    literal "undefined" the template literal would print).
  - **Well-formed feed verbatim** — already-valid record loads
    unchanged; pins that normalisation is idempotent on healthy
    inputs (i.e. doesn't silently rewrite a real `name` or
    drop / sort `entries`).

## Verify

- `@muse/cli` suite green (1071 passed, +4 vs baseline 1067, 0
  failed).
- **Clean-mutation-proven** (Edit-based): reverting the `.map(
  normalizeFeedRecord)` chain back to bare `filter(...)` makes
  exactly THREE of the four new tests fail — entries left as
  `null`/`"not-an-array"`/`42` instead of `[]`, and `name`
  comes back as `undefined`. The fourth (well-formed verbatim)
  still passes pre-fix because the bare filter is correct on
  already-valid inputs. Fix restored, suite back to 1071/1071.
- `pnpm check` green: apps/api 261/261, apps/cli 1071/1071,
  every workspace.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean on
  both touched files.
- No LLM request/response wire path touched. The Rust runner,
  the model adapters, the HTTP smoke surface are all unchanged.
  `smoke:live` doesn't apply.

## Status

Done. The `~/.muse/feeds.json` load boundary is now type-safe
against the FOUR realistic corruption / partial-write shapes a
hand-edit or older schema can produce:

| On-disk shape                          | Before                       | After                         |
| -------------------------------------- | ---------------------------- | ----------------------------- |
| `{id, url, name, entries: [...]}`      | OK                           | unchanged                     |
| `{id, url, name}` (no entries)         | **`muse feeds list` crash** on `.entries.length` | `entries: []` (**fixed**) |
| `{id, url, name, entries: null}`       | **same crash** on `.entries.length` | `entries: []` (**fixed**) |
| `{id, url, name, entries: "not-array"}`| same crash on `.length` (coerced to N or NaN) | `entries: []` (**fixed**) |
| `{id, url}` (no name either)           | renders literal `undefined`  | `name: "<id>"` (**fixed**)    |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
tolerant-read normalisation `fix:` on the personal-CLI store, in
the same family as goals 620 (credentials.json) and 615
(calendar registry tiebreaker). Recorded honestly with this
backlog row — not a false metric.

## Decisions

- **Normalise at the read boundary**, not at the call sites.
  `commands-feeds.ts:160` and `:170` both call
  `feed.entries.length`; a per-site `?? []` would scatter the
  same fix across N consumers and a future caller would forget
  it. The store is the contract surface; downstream sees a
  guaranteed-array.
- **`Array.isArray` not `Array.from`.** `Array.from("string")`
  silently turns `"abc"` into `["a","b","c"]` — accepting the
  corruption rather than reverting to the documented default.
  `Array.isArray(raw.entries) ? raw.entries : []` is strict:
  anything that isn't truly an array falls back to `[]`.
- **`name` falls back to `id`, not to `""` or `"unnamed"`.**
  The id is already user-visible (`muse feeds list` prints
  `${feed.id}\t...`) and the JSON output uses it as the
  stable handle. Mirroring it as the display name when the
  user never supplied one is the same convention `muse feeds
  add` itself uses at `commands-feeds.ts:144`
  (`name: options.name ?? id`). Consistent with the create path.
- **Spread `...raw` first, then override.** Keeps
  `lastFetchedAt` and any forward-compat field a future
  schema adds. Override order ensures `entries` / `name` use
  the normalised values, not the raw ones.
- **Test uses real `mkdtemp` + writeFile, not a mock.** The
  defect is at the read boundary; mocking `fs.readFile` would
  test a stub, not the live JSON.parse + cast + filter +
  normalise chain. Real tmp dir, real file, real round-trip.
- **`FEEDS_STORE_SCHEMA_VERSION` re-exported in the test**
  rather than hard-coded `1` so a future bump can't silently
  drift the tests off the version gate.
- **Did NOT also validate each feed's `lastFetchedAt`** (the
  third optional field). It's surfaced via template literals
  but no `.length` / `.getTime()` is called on it — a
  `lastFetchedAt: 42` would just render `42` (mild visual
  glitch, no crash). Scope-limited fix.
- **Mutation choice.** Reverted the whole `.map(
  normalizeFeedRecord)` chain — the realistic regression a
  maintainer might write while "simplifying" by inlining the
  filter back. Three tests fail pre-fix; the fourth (well-
  formed verbatim) correctly passes both pre- and post-fix
  because it doesn't depend on normalisation.

## Remaining risks

- **`FeedEntry` shape isn't validated inside `entries[]`.**
  An on-disk `entries: [42, null, {id: "ok", title: "T"}]`
  loads as a 3-element array; downstream filters (`if (entry.id)`
  in `mergeFeedEntries`) silently drop the bad two, but
  `compareFeedEntriesNewestFirst(a, b)` accesses `a.publishedAt`
  and `b.publishedAt` — on a `42` element that's `undefined` /
  passes through the `!Number.isFinite` branch and sorts to the
  tail. Not a crash, just a degraded experience. Out-of-scope
  for this iter; would need a per-entry normaliser the same way
  this iter normalised the per-feed record.
- **Sibling stores.** `apps/cli/src/persona-store.ts`,
  `apps/cli/src/feeds-store.ts`, `apps/cli/src/credential-store
  .ts`, `apps/cli/src/episode-index.ts` all carry the same
  read-and-cast pattern. This iter audited only feeds-store; an
  identical normalisation gap might exist in the others. Each
  would be its own iter (one defect, one fix, one test).
- **`name.length > 0`** rejects a zero-length string but
  accepts a whitespace-only one. `muse feeds add` already
  rejects whitespace at the input boundary, so a whitespace-
  only `name` only arrives via hand-edit — fairly rare. A
  `.trim().length > 0` check would tighten this, but at the
  cost of mutating the user's choice (e.g. a leading-space
  display name they intentionally added). Left as-is.
