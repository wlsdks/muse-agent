# 647 — `extractJsonArray` in plan-execute tracks `inString` + `escape` so a plan whose tool args contain a literal `]` / `[` inside a JSON string doesn't truncate at the spurious bracket — sibling-parity with `firstBalancedJsonBlock` in `structured-output.ts`

## Why

`packages/agent-core/src/plan-execute.ts:extractJsonArray` is
the LLM-output scanner that pulls the plan JSON array out of
the model's response (which often wraps the array in prose
like "Sure, here is the plan: [...] thanks!"). Pre-fix:

```ts
export function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}
```

The scanner only counts `[` / `]` characters. It does NOT
track JSON string literals. So a plan containing a literal
`]` or `[` inside a string value corrupts the depth counter:

```ts
extractJsonArray('[{"tool":"a","args":{"q":"find ]"},"description":"x"}]')
// → '[{"tool":"a","args":{"q":"find ]'   ← truncated at the spurious ]
```

The downstream `JSON.parse` at `parsePlan` line 101 then
throws on the malformed slice, falling through to `return
null` on line 103. The user gets "plan failed to parse" — a
legitimate plan silently dropped.

### Reachability

Plans routinely contain quoted strings with arbitrary content:

- Search queries: `{"q": "find ]"}` (bracket as a literal
  search term), `{"q": "find [TODO]"}`.
- File paths on Windows: `{"path": "C:\\Users\\me\\[archive]"}`.
- Markdown body content: `{"body": "see [link](url)"}`.
- Korean / Japanese text containing bracket-like glyphs: `『…』`
  (different from ASCII brackets but still occasionally
  paired with ASCII ones).
- LLM-generated tool descriptions that legitimately use `[`
  / `]` to denote optional parameters.

All of these silently break plan parsing pre-fix.

### Sibling already does this right

`packages/policy/src/structured-output.ts:firstBalancedJsonBlock`
(lines 84-115) handles BOTH `{` / `}` AND `[` / `]` AND tracks
`inString` + `escape`:

```ts
function firstBalancedJsonBlock(input: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < input.length; index += 1) {
    const ch = input[index];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === "\"") { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return input.slice(start, index + 1);
    }
  }
  return undefined;
}
```

`extractJsonArray` was the missed sibling — same JSON-block-
scanner shape, different (and less rigorous) implementation.

### Defect class

**Balanced-bracket parser missing string-literal awareness —
strings containing the closing-bracket character corrupt the
depth counter and produce a truncated candidate**. Fresh
against the recent window:

- 646: unbounded growth (FIFO cap)
- 645: file-mode 0o600
- 644: finite-guard (data destruction)
- 643: strict int-parse on HTTP query params
- 642: stream error listener
- 641: cacheTtlMs finite-guard
- 640: word-boundary keyword matching
- 639: keyword dedup
- 638: lenient base64url decode (auth)
- 637: lenient base64 decode (loopback)

Closest related is 637 / 638 (lenient decoder validation), but
those were about CHAR-LEVEL leniency in Buffer.from. This
is about TOKEN-LEVEL string-vs-bracket distinction in a
hand-written JSON scanner. Different defect family.

## Slice

- `packages/agent-core/src/plan-execute.ts:extractJsonArray`:
  - Added `inString` + `escape` state alongside the existing
    `depth` counter.
  - Order of checks mirrors `firstBalancedJsonBlock` exactly:
    escape → backslash-escape-flag → quote toggle → in-string
    skip → bracket count.
  - The function signature, return type, and behavior on
    well-formed input are unchanged.
- `packages/agent-core/test/agent-runtime.test.ts`:
  - One new test in the existing `extractJsonArray` describe.
    Three assertions covering:
    1. **Literal `]` inside a string** — `[{"tool":"a","args":
       {"q":"find ]"},"description":"x"}]` extracts cleanly
       post-fix; pre-fix truncates at the spurious `]`.
    2. **Literal `[` inside a string** — mirror case.
    3. **Escaped quotes inside the string** —
       `"say \"]\" loudly"` must not flip the `inString` flag
       back to false on the escaped inner `"` (the escape
       handling). Pins the backslash-escape branch.

## Verify

- `@muse/agent-core` suite green (663 passed, +1 vs the
  pre-iter baseline of 662, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the
  `inString` + `escape` state and the surrounding `if`
  guards back to the bare bracket counter makes the new
  test fail with the EXACT pre-fix symptom — `Received:
  '[{"tool":"a","args":{"q":"find ]'` (truncated at the
  spurious `]`) vs. `Expected: '[{"tool":"a","args":
  {"q":"find ]"},"description":"x"}]'` (full slice). The
  3 pre-existing extractJsonArray tests pass both pre- AND
  post-fix because none of them have brackets inside
  strings.
- `pnpm check` green: apps/api 270/270, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean.
- No LLM request/response wire path touched in code (this is
  the OUTPUT-PARSING side of plan-execute, called AFTER the
  model.generate() resolves). The fix silently improves plan
  acceptance rate — no behavioral change for healthy plans.
  `smoke:live` doesn't apply.

## Status

Done. `extractJsonArray` now handles every plan shape an LLM
might legitimately emit:

| Plan body                                              | Before                          | After                       |
| ------------------------------------------------------ | ------------------------------- | --------------------------- |
| `[{"tool":"a","args":{},"description":"x"}]`           | OK                              | unchanged                   |
| `[{"tool":"a","args":{"items":[1,2,3]},"description":"x"}]` | OK (nested brackets fine) | unchanged                   |
| **`[{"tool":"a","args":{"q":"find ]"},"description":"x"}]`** | **truncated → JSON.parse fail → null plan** | extracted cleanly (**fixed**) |
| **`[{"tool":"a","args":{"q":"find ["},"description":"y"}]`** | depth corruption → null plan | extracted cleanly (**fixed**) |
| **`[{"tool":"a","args":{"q":"say \"]\" loudly"},"description":"x"}]`** | escape flag confused → null plan | extracted cleanly (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness
/ parser-rigor `fix:` on the plan-execute output scanner.
Recorded honestly with this backlog row.

## Decisions

- **Mirror `firstBalancedJsonBlock` exactly**, not import it.
  Cross-package import (`@muse/agent-core` → `@muse/policy`)
  would introduce a new dependency edge for a tiny helper.
  Both copies are ~25 lines; if the scanner evolves in one
  place, a future iter can consolidate via `@muse/shared`.
  Goal 640 made the same call for the
  `containsKeywordWithBoundary` helper.
- **Same control-flow order** as the sibling: `escape` check
  first, then `\\` detection, then `"` toggle, then
  in-string skip, then bracket count. The order matters —
  if `\\` were checked before `escape`, a `\\\\` (two
  backslashes — escaped escape) would be mis-parsed.
- **Did NOT also handle `{` / `}`.** `extractJsonArray` is
  specifically for the plan top-level array shape; the
  `[` opener is what the function searches for. Nested
  objects inside (`{...}` inside steps) are valid but
  their internal `{` / `}` doesn't change the array's `]`
  depth. The bracket counter only tracks `[` / `]`.
- **One short JSDoc comment** stays — the function's
  contract ("returns null on missing array or unbalanced")
  is already documented at parsePlan line 89-93. No
  additional comment added to the function body — the code
  is self-evident with the sibling pattern's structure.
- **Mutation choice.** Reverted the entire string-tracking
  block (`inString`, `escape`, all four `if` guards) back
  to the bare bracket counter. One test fails with the
  exact pre-fix truncation symptom; the 3 pre-existing
  tests pass both pre- and post-fix.

## Remaining risks

- **Other balanced-bracket scanners** in the codebase. A
  grep finds:
  - `packages/agent-core/src/plan-execute.ts:extractJsonArray`
    (now fixed).
  - `packages/policy/src/structured-output.ts:firstBalancedJsonBlock`
    (already correct).
  - `packages/skills/src/skill-parser.ts:isJsonBlockComplete`
    (line 229) — already tracks `inString` + `escape` via
    its own implementation.
  Three scanners, two now correct, the new fix brings the
  third into parity.
- **JSON5 / trailing-comma support** is NOT added. The
  scanner still rejects JSON5 features (single-quoted
  strings, trailing commas). LLMs occasionally emit these;
  a future iter could route through `JSON5.parse` after
  the extract step.
- **Unicode-quote characters** (`“` U+201C, `”` U+201D)
  aren't treated as string delimiters. If the LLM emits
  curly quotes (rare in JSON contexts), the inString flag
  doesn't toggle. Out-of-scope; standard JSON requires
  straight quotes.
- **`firstBalancedJsonBlock` and the new `extractJsonArray`
  share 90% of their code** but are in different packages.
  A shared helper in `@muse/shared` would consolidate;
  out-of-scope for this iter, noted as a possible later
  refactor.
