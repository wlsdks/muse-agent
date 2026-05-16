# 216 — Ollama streaming tool calls were silently dropped

## Why

A severe provider-quality bug breaking the **defining JARVIS
capability — tool calling — on the primary local provider's
streaming path**. `OllamaProvider.stream` emitted tool-call
events only from a chunk where `parsed.done === true`, and
built `final.toolCalls` from `lastJson` (the last NDJSON
line). Empirically (curl against real `qwen3:8b` via
`/api/chat` `stream:true`):

```
line0: done=false content='' tool_calls=[{id:"call_…", function:{name:"get_weather", arguments:{city:"Paris"}}}]
line1: done=true  content='' tool_calls=None
```

Qwen streams the tool call in a **`done:false`** chunk; the
terminal `done:true` chunk carries **no** tool_calls. So:

- the streaming loop's `if (parsed.done && …tool_calls)`
  skipped line0 (`done:false`) and line1 had no tool_calls →
  **no `tool-call` event ever emitted**;
- `final.toolCalls` came from `lastJson` = line1 → **empty**.

Net: every streaming tool-using flow with Ollama Qwen
(`muse ask --with-tools`, `muse chat` with tools, agent-
runtime stream, proactive synthesis) **silently dropped the
tool call entirely** — the agent saw "no tool call" and
returned a generic/hallucinated reply instead of executing
calendar/tasks/notes actions. The non-streaming `generate`
path was unaffected (Ollama returns everything in one JSON).

## Scope

- `packages/model/src/adapter-ollama.ts` `stream`: capture
  `tool_calls` from **any** chunk (drop the `parsed.done`
  gate), dedup by `tc.id` (or `name:JSON.stringify(args)` when
  id-less) via a `seenToolKeys` set with a stream-wide
  fallback index, accumulate into `streamedToolCalls`, emit
  each new one as a `tool-call` event, and set
  `final.toolCalls = streamedToolCalls`. The old `lastJson`-
  based final mapping (which also duplicated the
  normalization) is removed — subsumed. Dedup keeps a
  hypothetical Ollama version that repeats tool_calls in the
  done line from double-emitting (model-loop also dedups by
  id, so this is defense-in-depth). No change to the
  non-stream path.

## Verify

- `pnpm --filter @muse/model test` — 142 pass / 5 skip (1 new
  regression: real qwen3 shape — tool_calls in a `done:false`
  chunk, empty `done:true` — asserts the `tool-call` event is
  emitted AND `final.toolCalls` is populated). Existing 141
  (whose fake puts tool_calls in the `done:true` line) still
  pass — the un-gated loop handles that shape too.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Real-LLM tool-calling path → dog-fooded on real Qwen
  (ollama/qwen3:8b, reasoning off):
  `muse ask --with-tools "Use the muse.tasks.add tool to add a
  task titled 'buy milk', then confirm."` →
  stderr `(tools used: muse.tasks.add)`, the model confirmed
  `"buy milk" has been added`, and the temp `tasks.json`
  contained `['buy milk']`. Pre-fix this path produced no
  tool execution at all.

## Status

done — streaming tool-use with local Qwen works again: a tool
call delivered in a `done:false` chunk is emitted live and
carried into the final response, deduped. The core JARVIS
tool-calling capability is restored on the primary local
provider's streaming path.
