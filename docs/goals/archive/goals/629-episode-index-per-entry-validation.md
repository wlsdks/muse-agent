# 629 — `loadEpisodeIndex` runs per-entry validation (and defaults `builtAtIso` to `""`) so a corrupt persisted `~/.muse/episodes-index.json` entry can't leak through the cast and crash `cosineSimilarity` at `commands-recall.ts:99` on `entry.embedding`

## Why

`apps/cli/src/episode-index.ts:loadEpisodeIndex` was the load
boundary for the semantic-recall index. Pre-fix:

```ts
if (typeof candidate.model !== "string" || !Array.isArray(candidate.entries)) return undefined;
return candidate as EpisodeIndex;
```

It validated the envelope — version, model presence, entries-is-
array — and then **returned `candidate` cast wholesale to
`EpisodeIndex`**. The cast lies whenever any individual entry
deviates from the declared shape:

```ts
export interface EpisodeIndexEntry {
  readonly id: string;
  readonly userId: string;
  readonly summary: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly embedding: number[];
}
```

Realistic corruption shapes the cast accepts silently:

- `embedding: null` / `embedding: undefined` (deleted by hand,
  written by an older code path) — `cosineSimilarity` at
  `apps/cli/src/commands-recall.ts:99` does
  `cosineSimilarity(queryVec, ep.embedding)`; `embed.ts:51`
  reads `b.length` first — `TypeError: Cannot read properties
  of null (reading 'length')`.
- `embedding: "string"` (a JSON tool encoded the array as a
  string by mistake) — `b.length` works but `b[i]` returns
  characters, multiplication with `a[i]` yields `NaN`, the
  result is `NaN` and ranking collapses.
- `embedding: { length: 3 }` (object with a length property
  but no indexable numbers) — same NaN cascade.
- `embedding: [0.1, NaN, 0.3]` (a divide-by-zero in the
  embedder, an `Infinity` from a tokenizer edge) — the cosine
  goes `NaN`, the `Number.isFinite` guard in `cosineSimilarity`
  returns 0 — silently buries the entry rather than ranking it.
- Missing `id` / `userId` / `summary` / `startedAt` / `endedAt`
  — partial-write recovery, hand-edit, or a forward-compat
  schema rename can produce these. Each missing string flows
  through to the recall display logic (`commands-recall.ts:262`
  reads `entry.summary` into the JSON output) and surfaces the
  literal `"undefined"` to the user.

`builtAtIso` was a parallel oversight: the type declared it
`string` but the load didn't validate it; a missing or non-
string field would expose `undefined` to consumers that render
the field as `"Index built at: ${index.builtAtIso}"`.

This iter's defect class — **untested cast lies; persisted
nested-array entries with corrupt shape leak through and crash
downstream consumers** — is a *sibling-store* extension of
goal 627 (feeds-store) to the recall index. Two siblings down,
two to go (`credential-store.ts` was fixed in 617/620;
`persona-store.ts` is already thorough — its load uses
`Object.create(null)` + per-entry type checks).

Step-8 redirect: matches the 627 pattern but on a different
store. Defect families since 619 cycle: keyword-filter →
memory-cap → atomic-write → file-mode → tiebreaker → CLI-trim
→ date-range → boolean-spelling → test-additions → graceful-
read → tolerant-read (627) → unit-promotion (628) → per-entry
validation (629). Different surface every iter — no repeat.

## Slice

- `apps/cli/src/episode-index.ts`:
  - After the envelope gates pass, validate each entry with a
    new local `isValidEpisodeIndexEntry(raw): raw is
    EpisodeIndexEntry` type guard:
    - `id` is a non-empty string
    - `userId`, `summary`, `startedAt`, `endedAt` are strings
    - `embedding` is an array
    - every element of `embedding` is a finite number
  - `entries = candidate.entries.filter(isValidEpisodeIndexEntry)`
    drops corrupt rows without sinking the whole index.
  - `builtAtIso` defaults to `""` when missing or non-string.
  - Return a new, freshly-constructed `EpisodeIndex` (not the
    raw cast) — `version` is set to the schema constant
    explicitly so a `version: 1.0` (number) vs. `version: 1`
    (also number) drift can't carry through.
- `apps/cli/src/episode-index.test.ts` (new file — module had
  ZERO direct test coverage before this iter):
  - Five tests under one `describe`:
    1. **Whole-file regression pin** — missing file / bad JSON
       / null root / wrong version / missing model / non-array
       entries all collapse to `undefined`. Pins the pre-fix
       gates still hold.
    2. **Well-formed verbatim** — a valid index round-trips
       unchanged (per-entry validation is a no-op on healthy
       data; pins idempotency).
    3. **Drops corrupt embeddings** — null / string / object /
       NaN / Infinity / missing all rejected; only the good
       row survives. Pins the crash-bearing path
       (`cosineSimilarity` can never see a non-array).
    4. **Drops missing string fields** — six malformed rows
       (no userId / no summary / no startedAt / no endedAt /
       no id / empty id) all rejected; result is `[]`.
    5. **`builtAtIso` defaults to ""** — missing field and
       non-string field both surface `""`, not `undefined`.
  - Tests use real `mkdtemp` + `writeFile`, with
    `afterEach(rm)` cleanup. No mocking of `fs` — the defect
    is at the load boundary; mocking would test a stub.

## Verify

- `@muse/cli` suite green (1089 passed, +5 new tests in the
  new test file, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the per-
  entry filter back to `return candidate as EpisodeIndex` (the
  pre-fix line) makes EXACTLY THREE of the five new tests
  fail — corrupt embeddings leak through, missing-field
  entries leak through, and `builtAtIso` comes back
  `undefined` instead of `""`. The whole-file regression-pin
  and the well-formed verbatim test pass pre- AND post-fix —
  confirms the fix is purely additive on healthy / wholly-bad
  inputs and only changes behavior for the corrupt-row cases.
  Fix restored, suite back to all green.
- `pnpm check` green: apps/api 261/261, apps/cli 1089/1089,
  every workspace.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean on
  both touched files.
- No LLM request/response wire path touched (the embedding
  vectors are STORED, not invoked here). `smoke:live` doesn't
  apply.

## Status

Done. The `~/.muse/episodes-index.json` load boundary is now
shape-safe against five realistic corruption modes. Downstream
`muse recall`, `muse episode reindex`, and any future episode-
similarity consumer can trust the type:

| Corruption shape                       | Before                  | After                   |
| -------------------------------------- | ----------------------- | ----------------------- |
| Well-formed entries                    | OK                      | unchanged               |
| `embedding: null`                      | **TypeError on `.length`** in cosineSimilarity | entry dropped (**fixed**) |
| `embedding: "string"` / `{length: 3}`  | NaN cascade — silent rank failure | entry dropped (**fixed**) |
| `embedding: [..., NaN, ...]`           | NaN cascade — `cosineSimilarity` returns 0, entry silently zero-scored | entry dropped (**fixed**) |
| Missing `id` / `userId` / `summary`    | leaked through; recall JSON shows `"undefined"` | entry dropped (**fixed**) |
| Missing `builtAtIso`                   | `undefined` rendered to user as the literal "undefined" | `""` (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a tolerant-
read / per-entry validation `fix:` on a sibling personal store,
sibling-pattern to 627 (feeds-store). Recorded with this
backlog row.

## Decisions

- **Drop invalid entries, not the whole index.** Mirrors
  feeds-store 627 — one corrupt row shouldn't sink the
  remaining 999 healthy ones. The wrong-version / wrong-model
  / non-array-entries gates still collapse the WHOLE index to
  `undefined` (correct: that's a "this isn't the format we
  understand" situation, and `commands-episode.ts` will
  rebuild on next reindex).
- **`id.length === 0` is invalid.** An empty-string id is
  technically a valid string but breaks `commands-episode.ts`
  reindex's `reusable.set(entry.id, entry)` — two empty-id
  entries would collide on the Map key. The pre-628 code
  silently accepted them; rejecting them here makes the
  invariant explicit at the load boundary.
- **`Number.isFinite(n)` on every embedding element.** `NaN`
  and `Infinity` are technically `typeof "number"` but break
  the cosine math silently — `cosineSimilarity` returns 0,
  which buries the entry without warning. Rejecting at the
  load boundary surfaces the corruption faster (the user can
  reindex).
- **`builtAtIso` defaults to `""`, not the file mtime or
  `"unknown"`**. The field is rendered into the JSON output
  and into a CLI status line; `""` is the safest sentinel
  because consumers can do a length-zero check to decide
  whether to display the field at all. `"unknown"` would
  render literally.
- **Return a freshly-constructed object, not the cast
  candidate.** Pins the `version` field to the schema
  constant (`EPISODE_INDEX_SCHEMA_VERSION`), drops any
  forward-compat fields the on-disk envelope might carry
  (small future-compat cost; obvious safety win). Also
  reassures TypeScript — the return type is now CONSTRUCTED,
  not asserted.
- **New test file, not appended to an existing one.** The
  `episode-index.ts` module had ZERO direct test coverage
  before this iter. A new `episode-index.test.ts` next to
  the source matches the established `<module>.test.ts`
  convention used by `feeds-store.test.ts`,
  `human-formatters.test.ts`, `commands-doctor.test.ts`, etc.
- **Mutation choice.** Reverted the whole 4-line block back
  to `return candidate as EpisodeIndex` — the realistic
  regression a maintainer might write while "simplifying" the
  load function. Three tests fail with exact pre-fix
  symptoms; two pass both pre- and post-fix because they pin
  envelope gates (which are unchanged) and the well-formed
  verbatim shape (which is correct under both implementations).

## Remaining risks

- **`buildEpisodeIndex`** (the reindex builder) doesn't
  re-validate `previous.entries` before reusing them — it
  trusts the loader. Since the loader is now the contract
  source, this is correct, but a caller that hand-constructs
  `previous` (test code, future migration code) could still
  feed corrupt entries directly. Out-of-scope for this iter.
- **`commands-recall.ts:203`** still does
  `episodeIndex?.entries ?? []` — that handles the
  `loadEpisodeIndex → undefined` path, but with the per-entry
  filter in place, an entries-empty case (everything dropped)
  is now reachable. The downstream `episodeEntries.map(...)`
  / cosineSimilarity loop both no-op on an empty array, so
  this isn't a crash — just an empty recall result. Worth
  surfacing a `"index has 0 valid entries — try \`muse
  episode reindex\`"` hint in a future iter.
- **`saveEpisodeIndex` is symmetric — it serializes the
  current shape verbatim** (no schema-version migration, no
  enforced sanitisation). A consumer that constructs an
  `EpisodeIndex` in memory with non-string fields could write
  a malformed file. The loader now catches this on read, but
  the loader-write asymmetry is worth flagging.
- **`persona-store.ts`** was already thorough — no fix needed.
  The remaining sibling stores in `apps/cli/src/` to audit
  are minor (the credential store was fixed in 617/620).
