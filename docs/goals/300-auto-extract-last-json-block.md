# 300 — auto-extract took the FIRST JSON block, discarding the real payload

## Why

`extractJsonObject` (`@muse/memory`) parses the model's
memory-extraction output — the JSON of new
facts / preferences / **vetoes** / goals that the
`UserMemoryAutoExtract` hook persists. It's how a personal JARVIS
"remembers what you told it", and with the project's Qwen-only
constraint the input is always a **small local model**'s output.

The slow path (no clean fence) used
`findFirstBalancedBraceBlock` — the **first** balanced `{ … }`.
Small models routinely echo the schema or an empty example
*before* the real answer, e.g.:

```
Example shape:
{"facts":{},"preferences":{},"vetoes":[],"goals":[]}
Here is what I found:
{"facts":{"name":"Stark"},"vetoes":[{"id":"no-eggs","value":"never suggest eggs"}]}
```

The first balanced block is the empty example, so it parsed
`{}`-everything and the **real extraction was silently
discarded** — the user's name and the "no eggs" safety veto were
never persisted. Separately, the brace scanner toggled string
state on **any** `"`, including in the depth-0 prose prefix, so a
single stray quote ("He said \"wait, then: { … }") flipped it
into string mode and swallowed the opening brace → `undefined`.
Both silently break the memory pipeline.

## Scope

`packages/memory/src/memory-auto-extract.ts`:

- Replace `findFirstBalancedBraceBlock` with
  `findBalancedBraceBlocks` — collects **all** top-level balanced
  blocks; the slow path returns the **last parseable** one (the
  model's final JSON is its answer; examples / prose / reasoning
  precede it). One short WHY comment records the
  small-model-echoes-schema rationale.
- The new scanner only treats `"` as string state when
  `depth > 0`, so quotes in the depth-0 prose prefix can no
  longer hijack the parser (latent bug fixed in passing).
- Fast path (fence-strip + direct parse) is unchanged and still
  short-circuits the clean case.

Behaviour-preserving for every prior input: a single-block
response (clean / fenced / prose-prefix / trailing-comment /
nested-braces-in-strings) has exactly one block, so last == the
only block — identical result.

## Verify

- `pnpm --filter @muse/memory test` — 153 pass (was 150; +3).
  New regressions: an empty-schema example followed by the real
  payload now yields the real `facts` + `vetoes` (pre-fix:
  `{}`); a trailing unbalanced `{` after a valid object is
  skipped; an unbalanced prose quote no longer swallows the
  brace. The existing clean / fenced / bare-fence / prose-prefix
  / trailing-comment / nested-brace / non-object tests stay
  green.
- `pnpm check` — every workspace green (memory 153, apps/cli
  563, apps/api 160, all packages). `pnpm lint` — exit 0.
- Real-LLM path touched (parses the model's extraction output)
  → dog-fooded a real Qwen round-trip: `OllamaProvider`
  `qwen3:8b` (`127.0.0.1:11434`, `think:false`, no paid key) on
  the auto-extract system prompt + a turn stating a name and an
  egg allergy → qwen3:8b returned clean JSON and the refactored
  `extractJsonObject` parsed `facts:{name:"Stark"}` and the
  `veto {id:"no_eggs", scope:"food"}` — confirming the common
  clean path is unregressed end-to-end; the messy multi-block /
  leading-example / stray-quote cases (which a single live run
  can't force on demand) are pinned by the deterministic
  regressions.

## Status

done — auto-extract now reads the model's *final* JSON object,
so a small local model echoing the schema or an empty example
first can no longer silently wipe the real facts/vetoes/goals
before they're persisted. The clean path and all prior shapes
are unchanged; a latent prose-quote parser bug was fixed in the
same scanner.
