# 226 — episodic summary parsing must use the LAST `topics:` line

## Why

`parseSummariserOutput` (`episodic-summariser.ts`) turns the
LLM's session-recap text into the structured
`{ summary, topics }` that becomes the **episodic-memory
entry** — the JARVIS long-term memory of a past session
(`~/.muse/episodes.json`, goals 189–191). Its own comment
states the contract:

> The `topics:` line is the **last** one when present;
> everything else is the summary body.

But the code did:

```ts
const topicsIndex = lines.findIndex((line) => /^topics:\s*/iu.test(line));
```

`findIndex` returns the **FIRST** match. When a small model
(qwen3:8b restates / emits structure twice) produces more than
one `topics:`-prefixed line — e.g. a mid-summary label plus
the real trailing one — `topicsIndex` lands on the *first*:
`body = lines.slice(0, topicsIndex)` **truncates the summary
prematurely** (losing every sentence after the first
`topics:`), and the topics are parsed from the *wrong*
(earlier, partial) line while the real final topics are
dropped. The episodic-memory entry for that session is then
silently wrong and incomplete — a corrupted long-term memory
the agent later recalls.

## Scope

- `packages/agent-core/src/episodic-summariser.ts`: take the
  **last** matching line as the boundary, matching the
  documented contract. Implemented as a reverse scan rather
  than `Array.findLastIndex` to avoid bumping the package's
  TS `lib` target (es2023) — a broad, out-of-scope change;
  the reverse scan is runtime-identical. Single-`topics:` and
  no-`topics:` outputs are unaffected (last == first ==
  none), so the canonical / no-section behavior is unchanged.
- `packages/agent-core/test/episodic-summariser.test.ts`:
  new regression — a 4-line output with two `topics:` lines
  (early partial + real trailing) now keeps the full body
  (incl. the post-first-topics sentence) and parses topics
  from the **last** line. Existing canonical + no-topics
  tests unchanged.

## Verify

- `pnpm --filter @muse/agent-core test` — 525 pass (1 new;
  canonical/no-topics/fail-soft cases unchanged → no
  regression).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Deterministic output-parser fix: the model invocation
  (`modelProvider.generate`) is unchanged; only the
  post-parse. The exact problematic multi-`topics:` shape is
  unit-tested via the `stubProvider` (the authoritative
  verification per the testing rules). Forcing qwen3:8b to
  emit a double-`topics:` shape on demand is non-deterministic
  and would add nothing over the deterministic test, so no
  smoke:live — same stance as the output-parsing goals
  208/209/219.

## Status

done — a restated / early `topics:` line no longer truncates
the episodic summary or drops the real topics; the parser now
honors its documented "last `topics:` line is the boundary"
contract. Long-term memory entries are no longer silently
corrupted on multi-marker model output.
