# 415 — OpenAI Responses tool-args get the same object-guard as the other two paths

## Why

Type-safety / consistency fix on a fresh axis (`@muse/model`
`provider-openai.ts` — never touched by the recent
autoconfigure/scheduler/calendar/mcp/policy cluster). The OpenAI
Responses API (`/v1/responses`) is a required provider family per
`architecture.md` and is shipped + contract-tested.

`ModelToolCall.arguments` is typed `JsonObject`. Muse has THREE
places that turn a model's raw tool-call arguments into that field:

- chat-completions (non-stream + stream) → `parseToolArguments`,
  which try/catch-parses AND guards `isJsonObject(parsed) ? … : {}`;
- the Ollama native adapter → guards
  `typeof === "object" && !Array.isArray ? … : {}`;
- the OpenAI **Responses** path (non-stream `output[]` +
  streaming `response.output_item.done`) → `JSON.parse(…) as
  JsonObject` inside a try/catch but with **no `isJsonObject`
  guard**.

So a Responses model emitting `arguments: "[1,2,3]"` / `"5"` /
`"null"` / `"\"x\""` produced a `ModelToolCall.arguments` that was
an array / number / null / string — a direct violation of the
declared `JsonObject` type that flows into the tool runner (which
spreads/`Object.entries` the args expecting an object). Two of the
three paths defended against exactly this; the Responses path was
the lone inconsistent one.

## Slice

- `packages/model/src/provider-openai.ts` — both Responses
  function-call sites (non-stream `output[]` extraction and the
  streaming `response.output_item.done` handler) now route through
  the existing `parseToolArguments` instead of an inline
  `JSON.parse(...) as JsonObject`. This both adds the missing
  `isJsonObject` guard and DRYs the duplicated try/catch — all
  three tool-arg paths are now the one guarded helper.
- `packages/model/test/model.test.ts` — new describe: non-object /
  malformed argument JSON (`[1,2,3]`, `"…"`, `5`, `null`, `{not
  valid`) collapses to `{}` on both the non-stream and streaming
  Responses paths; a well-formed object still parses (no
  regression). Fails on the pre-fix code (`[1,2,3]` came through
  as an array).

## Verify

- `@muse/model` full suite 162/162 (10 files); the new
  object-guard cases fail on the pre-fix code.
- `pnpm check` EXIT=0, every workspace green (model 162, api 194,
  cli 717, …); tsc strict (model) clean (the `JsonObject` import
  is still used; no dead vars from the removed inline blocks);
  `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean.
- Deterministic response-parsing change verified with fake-fetch
  fixtures. No real-Qwen round-trip applies: this is the OpenAI
  Responses adapter, which `smoke:live` (LOCAL OLLAMA QWEN ONLY)
  never exercises; the Ollama adapter was not modified (it already
  had the guard). The behavior is fully deterministic, so the
  contract tests are the correct and sufficient verification.

## Status

Done. The OpenAI Responses adapter can no longer hand the tool
runner a non-object `arguments` (array / primitive / null) on a
malformed or non-object model emission — it collapses to `{}`
exactly like the chat-completions and Ollama paths. The three
tool-arg parsing paths are now consistent and share one guarded
helper.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a type-safety/consistency fix to an
existing required provider adapter, recorded honestly as a
`fix(model):` change with this backlog row — not a false metric.

## Decisions

- Consolidated onto `parseToolArguments` rather than adding an
  inline `isJsonObject` check at each site: a single shared helper
  is the reason the other two paths never had this bug, and it
  removes the duplicated try/catch — fixing the defect and the
  drift that caused it in one move (the same "single source of
  truth" rationale as the goal-413 cron-validation fix).
- Scope held to the Responses path: the chat + Ollama paths
  already guard correctly and were left untouched (verified, not
  assumed) — no speculative widening.
