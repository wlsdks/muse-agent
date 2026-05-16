# 230 — in-REPL `/remember` must not misreport a provider error as bad input

## Why

The in-REPL parallel of goal 203 (and the last uncovered case
of the 201–207 error-swallow sweep). `chat-repl-slash.ts`'s
`/remember` slash command — whose own comment says it
"Mirrors the top-level `muse remember` command but works
in-REPL" — drained the model stream handling only
`text-delta`:

```ts
for await (const ev of deps.assembly.modelProvider.stream(...)) {
  if (ev.type === "text-delta" && typeof ev.text === "string") raw += ev.text;
}
const payload = deps.autoExtract?.extractJsonObject(raw);
if (!payload || !deps.memoryStore) {
  io.stdout("(nothing extracted — try rephrasing)\n"); return;
}
```

A provider `error` event (Ollama down, model not pulled —
goal 176's `ollama pull` hint, a 5xx) is **not** a thrown
exception, so the surrounding `try/catch` is never triggered;
the loop iterates past it, `raw` stays `""`,
`extractJsonObject("")` → falsy, and the user is told
**"(nothing extracted — try rephrasing)"** mid-conversation.
That actively misdirects: the model never ran, the statement
was fine, and the real fix is never shown — exactly the
misleading-diagnostic bug goal 203 fixed for the top-level
`muse remember`, here in the in-REPL twin.

## Scope

- `apps/cli/src/chat-repl-slash.ts`: replace the bespoke
  text-delta-only loop with the goal-201 `consumeAskStream`
  helper (no-op `onDelta` — `/remember` buffers then
  JSON-parses, identical to goal 203's `commands-remember.ts`).
  On `error`: `io.stdout("(error: <msg>)")` and `return`
  **before** the JSON-parse path, so the actionable provider
  error replaces the wrong "rephrase" message. Mirrors goal
  203 exactly; the cross-module import of the shared
  `consumeAskStream` is the same precedent set by goals
  202/203/204.

## Verify

- `pnpm --filter @muse/cli test` — 536 pass (no regression;
  `consumeAskStream` already has 4 direct unit tests from
  goal 201, which cover the drain/error contract `/remember`
  now delegates to — no new untested logic).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Verification scope (transparent, same as goal 207): the
  interactive slash handler runs only inside `runChatRepl`,
  which hardcodes `process.stdin` and can't be driven
  non-interactively here. Sound by construction: the
  byte-identical delegation pattern was dog-fooded on real
  Qwen in goal 203 (`muse remember --model
  ollama/nope-7b` → the actionable `ollama pull` error), and
  `consumeAskStream`'s error path is deterministically
  unit-tested (201). No new/unexercised code path.

## Status

done — the error-swallow sweep is now complete across the
one-shot (ask 201, brief 202, remember 203, read 204),
background (job-worker 205), interactive-chat (chat-repl 207),
and in-REPL-slash (`/remember` 230) surfaces. A failed model
request during `/remember` now surfaces the provider's
actionable error instead of blaming the user's phrasing.
