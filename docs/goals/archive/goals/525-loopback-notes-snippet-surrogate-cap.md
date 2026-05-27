# 525 — `muse.notes` loopback MCP server search snippet drops a lone trailing high surrogate (goal-516 sibling on the loopback wire)

## Why

Goal 516 closed the surrogate-cap defect on
`LocalDirNotesProvider.search` (the **library** consumer). The
analogous defect lived in `packages/mcp/src/loopback-notes.ts:278`
on the **MCP loopback** wire that the agent itself uses to query
notes:

```ts
matches.push({
  line: index + 1,
  path: rel,
  snippet: line.length > 240 ? `${line.slice(0, 240)}...` : line
});
```

`String.prototype.slice` cuts on UTF-16 code units. An astral
character (emoji, math symbol, CJK extension) is two UTF-16 units
— high surrogate (0xD800–0xDBFF) followed by low surrogate
(0xDC00–0xDFFF). If a line has an emoji whose high surrogate
sits at index 239 and low surrogate at 240, `slice(0, 240)`
keeps the high surrogate and discards the low surrogate — the
loopback search result returned to the agent contains a lone
trailing high surrogate.

This sibling-asymmetry to goal 516 is on a HOTTER wire path: the
loopback search is what the agent reaches for during ToolCall
loops to find context in the user's notes (`muse.notes.search`).
The library `LocalDirNotesProvider.search` (goal 516) is the
CLI-direct path; the loopback is the LLM-toolcall path. Both need
the same surrogate-cap convention.

## Slice

- `packages/mcp/src/loopback-notes.ts` — imported the existing
  `sliceWithoutLoneSurrogate` helper from
  `./notes-providers-local.js` (same package, no new
  cross-package dependency), then swapped the call site:
  ```ts
  snippet: line.length > 240
    ? `${sliceWithoutLoneSurrogate(line, 240)}...`
    : line
  ```
  Behaviour byte-identical for every line that does NOT have a
  surrogate pair straddling index 239/240 — only the boundary-cut
  path is closed. Same fix shape as goal 516 (notes-providers-
  local).
- `packages/mcp/test/mcp.test.ts` — added one new integration
  test in the existing `muse.notes loopback` describe block:
  writes a note with an emoji at code-unit index 239 via the
  `save` tool, then invokes the loopback `search` tool, asserts
  the returned snippet contains NO lone surrogate at any index.

## Verify

- New test 1/1 green; full `@muse/mcp` suite green (525 passed,
  +1 vs baseline 524, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the loopback
  call site back to a bare `line.slice(0, 240)` makes the new
  integration test fail with the precise pre-fix symptom —
  `loopback snippet index 239 must not be a lone surrogate:
  expected true to be false`. Every other test stays green. Fix
  restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure UTF-16 cap helper, reused — no LLM request-response wire
  path change in observable behaviour for clean content. The
  defended path is the `muse.notes.search` loopback tool's
  result snippet, which feeds the agent's tool-call context;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. The agent's `muse.notes.search` loopback result snippets
no longer leak invalid UTF-16 when a note line has an emoji at
the 240-char boundary. The cross-package surrogate-cap
convention now reads identically across seven sibling sites:

- messaging response filter (451)
- agent-core max-length filter (499)
- followup summariser (500)
- user-memory store (501)
- notes search-result snippet — library path (516)
- chat-history compaction summary (524)
- notes search-result snippet — loopback path (this goal)

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry robustness
`fix:` closing the loopback-vs-library asymmetry on the notes
search snippet, recorded honestly with this backlog row —
not a false metric.

## Decisions

- Imported `sliceWithoutLoneSurrogate` from the sibling module
  (`./notes-providers-local.js`) rather than re-defining the
  helper locally. Both modules live in `@muse/mcp` — same
  package, no cross-package coupling concern. The pre-existing
  export from goal 516 was specifically marked as exported to
  enable this kind of reuse within the package.
- Wrote an end-to-end integration test through the loopback
  `save` → `search` tool chain rather than a unit test on the
  internal handler: the value of the loopback fix is precisely
  that the agent's tool-call result is well-formed, so the
  test exercises the agent's actual surface. Mirrors goal
  516's integration-test choice.
- Step-8 continuation from goal 524 (chat-history compaction
  surrogate-cap on the LLM-prompt wire) to goal 525 (notes-
  loopback surrogate-cap on the tool-call wire) — both pre-LLM
  serialisation boundaries on different consumer surfaces.
  Productive sibling sweep, not same-area churn (different
  package, different code path, different test surface).
- Did NOT also fix the other `slice(0, 200/500)` sites in
  `packages/mcp/src/proactive-notice-loop.ts:658,670`,
  `tasks-providers-apple.ts:341`, etc. Those are error-message
  truncations where the wire is human-readable (a stderr log,
  a Notion error response). The fix here was specifically the
  LLM-context-feeding sites where invalid UTF-16 has a
  downstream impact (re-encoding crashes, tokeniser bugs).
  Different consumer contracts warrant different decisions;
  goals 524 and 525 cover the LLM-context sites.
