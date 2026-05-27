# 653 — `flattenIntoKv` (the `kv_summarize` tool's recursive flattener) bounds recursion at `KV_SUMMARIZE_MAX_DEPTH = 32` so a maliciously / accidentally deeply-nested tool result can't stack-overflow the agent process — emits a `[deep]` marker at the cap instead of recursing forever

## Why

`packages/tools/src/muse-tools-text.ts:flattenIntoKv` is the
recursive flattener powering the `kv_summarize` ambient tool.
The agent calls it on any tool result that needs to be folded
into a `key: value` text summary — typically downstream of
another tool's structured output.

Pre-fix the function recursed without a depth bound. A
deeply-nested JSON input — e.g.

```json
{"nested": {"nested": {"nested": ... }}}
```

with 100k+ levels — would consume one V8 stack frame per
level. The default Node stack is ~10 MB; each frame here is
~100 bytes; so ~100k frames hits the ceiling and crashes the
agent process with `RangeError: Maximum call stack size
exceeded`.

The existing `KV_SUMMARIZE_MAX_LINES = 200` cap doesn't help
because the recursion descends BEFORE emit-and-count happens.
By the time the 201st `emit` would be rejected, the recursion
has already gone N levels deep.

**Threat surface**:

- **Tool authors writing recursive JSON unintentionally**. A
  graph-walk tool that produces parent→child→parent cycles,
  serialised via `JSON.stringify` (which would throw on a
  real cycle — but a tree with 50k depth serialises fine).
- **An LLM that emits structured output with degenerate
  nesting**. Less common with modern models, but possible
  on the long tail.
- **An adversarial tool wired by an MCP server**. An MCP
  server an operator allowlisted (`McpSecurityPolicy.
  allowedServerNames`) returns structured data the operator
  trusts; if that server is compromised, it can return a
  100k-deep object and crash Muse on the next `kv_summarize`
  call.

The fix is a one-line guard: pass `depth` through the
recursion and emit `${prefix}: [deep]` once `depth >= 32`.
Thirty-two levels is generous against any realistic JSON
shape — typical structured tool outputs are < 10 levels
deep.

### Defect class

**Recursion without depth bound** — first hit. Fresh against
the recent 10-iter window:

- 652: error msg control-char sanitization
- 651: non-crypto RNG for security token
- 650: LLM timestamp sanity bound
- 649: unbounded HTTP body
- 648: HTTP fetch timeout
- 647: bracket parser inString
- 646: FIFO cap (unbounded growth)
- 645: file mode 0o600
- 644: finite-guard data destruction
- 643: strict int-parse

None previously hit the "recursive function with no depth
limit" class. Related to 646's unbounded-growth posture but
the mechanism is different — stack-frame consumption vs
heap accumulation.

## Slice

- `packages/tools/src/muse-tools-text.ts`:
  - **New export** `KV_SUMMARIZE_MAX_DEPTH = 32`.
  - `flattenIntoKv` now takes a fourth arg `depth: number = 0`.
    Recursive call sites pass `depth + 1`.
  - **Depth check at function entry**: if `depth >=
    KV_SUMMARIZE_MAX_DEPTH`, emit `${prefix || "value"}:
    [deep]` and return. Caps the recursion before consuming
    another stack frame.
- `packages/tools/test/tools.test.ts`:
  - **Two new tests** in the existing `kv_summarize` describe:
    1. **Deep-nested object/array → `[deep]` marker**. Build
       a 100-level chain `{nested: {nested: ...}}` and a
       100-level array-of-arrays. Assert the summary
       contains `[deep]` and does NOT contain the
       deepest-leaf value.
    2. **Sub-cap structure intact**. Build a 10-level
       chain. Assert the summary does NOT contain `[deep]`
       and DOES include the `leaf: value` line. Regression
       guard so the cap doesn't false-positive on
       legitimately-shallow JSON.

## Verify

- `pnpm --filter @muse/tools test`: 79 passed | 1 skipped
  (77 prior + 2 new). `pnpm check` full: every workspace
  green; tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the depth-check
  block (the `if (depth >= KV_SUMMARIZE_MAX_DEPTH) { emit
  ...; return; }` lines) makes EXACTLY the deep-recursion
  test fail with the exact symptom — the 100-level chain
  unwinds fully and the summary contains `nested.nested.
  ...nested.leaf: innermost`. The sub-cap regression test
  passes both pre- and post-fix because its depth is below
  any cap value. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched (this is the
  in-process ambient `kv_summarize` tool's recursion, not a
  model round-trip). `smoke:live` doesn't apply.

## Status

Done. `kv_summarize` can no longer stack-overflow the agent
process on a deeply-nested tool result:

| Input nesting depth                  | Pre-fix                            | Post-fix                          |
| ------------------------------------ | ---------------------------------- | --------------------------------- |
| 5 levels (typical tool result)        | unchanged                          | unchanged                         |
| 30 levels (atypical but legitimate)   | unchanged                          | unchanged                         |
| 32 levels (cap boundary)              | full traversal                     | full traversal at depth 31, marker at depth 32 |
| 100 levels (degenerate / malicious)   | full traversal (100 frames OK)     | marker at depth 32, no further recursion |
| 100k levels (adversarial)             | **RangeError stack overflow**      | **bounded, agent survives**        |

## Decisions

- **Depth = 32, not lower / higher**. Real-world structured
  tool outputs (HTTP API responses, file metadata, AST
  serializations) rarely exceed 10 levels. 32 is generous
  against any honest input while bounded well below the V8
  stack ceiling (~100k frames). An operator's bizarre
  edge-case 31-level JSON still flattens correctly; a 100k
  attack stops at depth 32.
- **`[deep]` marker, not a thrown error**. The tool's
  contract is "return a flattened summary"; abandoning
  with a throw would break the LLM's tool loop. The marker
  truthfully signals "we stopped recursing here" and the
  LLM can re-formulate (e.g., ask for a specific subpath)
  if it cares about the deep contents.
- **`depth + 1` at each recursive call site** (the
  array-iter loop and the object-entry loop), not at
  function entry. Function entry would need to compute
  depth from caller state; passing it in is cleaner and
  matches the rest of the codebase's recursive-with-depth
  pattern.
- **Default-parameter `depth: number = 0`**. Existing
  callers (line 104: `flattenIntoKv(data, "", emit)`) get
  depth=0 implicitly, no API break.
- **Exported constant**. Future iters that want to scan
  for `[deep]` markers or analyse "depth-cap-hit" frequency
  in tool outputs can reference the same constant. Pinned
  by the test indirectly (the 100-level test depends on
  the cap being below 100).
- **Mutation choice**. Reverted only the depth-check block.
  The deep-recursion test fails with the exact unwound
  output; the sub-cap regression and 77 other existing
  tests pass either way. Surgical proof.

## Remaining risks

- **Other recursive functions in the codebase** without
  depth bounds:
  - `packages/agent-core/src/tool-output-evidence.ts:
    parseToolOutputJson` — recurses when `parsed.result`
    is itself a string. A `{"result": "{\"result\":
    \"...\"}"}` chain could nest. Sibling-fixable.
  - `packages/mcp/src/notes-providers-local.ts:walk` —
    recursive directory walk. Bounded by `Dirent.
    isSymbolicLink()` filter that skips symlinks (so no
    cycle), but a real-disk directory with 1000+ levels
    of nesting could blow the stack. Sibling-fixable.
  - `packages/skills/src/skill-parser.ts:254` — uses a
    string-aware bracket parser (no recursion). Safe.
  Each is its own iter when the defect-class rotation
  circles back.
- **`KV_SUMMARIZE_MAX_DEPTH = 32` is hardcoded**. An
  operator who needs to flatten a deeper structure must
  edit the constant. Future iter could wire env override
  if it becomes useful.
- **The `[deep]` marker text isn't internationalised**.
  Other Muse markers stay in English (`"[empty]"`,
  `"...(N more)"`), so this is consistent. If a future
  iter localises tool output, this marker comes along.
- **Cycle detection NOT added**. JSON cycles can't exist
  in JSON.stringify-produced output (it throws), but a
  hand-constructed `JsonValue` could have cycles. The
  depth cap catches cycles indirectly — at most 32 levels
  before the marker. A real cycle-detection (visited Set)
  would be cleaner but out of scope for this iter.
