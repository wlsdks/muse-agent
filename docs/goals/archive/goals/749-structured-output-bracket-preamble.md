# 749 — fix: structured-output JSON lost when a non-JSON bracket preamble precedes the value

## Why

`normalizeStructuredOutput("…", "json")` (`@muse/policy`) extracts the
JSON value from a model reply for the structured-output response
filter. It took ONE candidate — the first balanced block from the
EARLIEST `{`/`[` opener — and gave up if that block didn't parse:

```ts
const candidate = extractJsonCandidate(stripMarkdownFence(content));
try { return JSON.parse(candidate) … } catch { return { normalized: false } }
```

A small local model (qwen3:8b) often wraps its answer in prose
containing brackets — e.g. `see [details below]: {"ok":true}`. The
earliest opener is the prose `[`, so the extracted block is
`[details below]`, which fails `JSON.parse`, and the genuinely-valid
`{"ok":true}` that follows is **silently discarded** (`normalized:
false` → the raw prose-wrapped reply is returned instead of the clean
JSON). The existing tests only covered cases where the first balanced
block is itself valid, so the gap was uncovered.

## Slice

`normalizeJsonOutput` now iterates the balanced blocks in
first-appearance order (one per opener via a `jsonCandidates`
generator) and returns the FIRST that parses — skipping a non-JSON
bracketed preamble to recover the valid value after it. When the first
block is valid it's still chosen (prior behavior preserved); only the
"first block fails to parse" path changed.

## Verify

- `@muse/policy` structured-output.test.ts (new): `see [details below]:
  {"ok":true}` → normalizes to the object; `Items: [1,2,3] then {"n":1}`
  → still takes the valid first array (no skip-past-good-value
  regression). The 7 pre-existing cases (fenced, object-first prose,
  trailing-example, brace-in-string, invalid→fail-open, YAML) still
  pass. **Mutation-proven** — reverting to give-up-after-first-candidate
  fails the preamble case.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). Deterministic
  text→JSON extraction (post-processes the model's text output) — not
  the model request path, so no `smoke:live`.

## Decisions

- **Try-each-until-parse, not first-opener-only** — preserves the
  documented "first balanced block" intent for valid early values (the
  tested cases) while recovering from a leading non-JSON bracket. The
  generator is lazy: it stops at the first block that parses.
