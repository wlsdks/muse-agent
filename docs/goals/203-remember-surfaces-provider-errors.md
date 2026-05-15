# 203 — `muse remember` must not misreport a provider error as bad input

## Why

Continuing the goal 201/202 error-swallow sweep.
`muse remember` uses the LLM to extract structured
facts/preferences from a natural-language statement and
persist them to the user-memory store. It drained the stream
handling only `text-delta`:

```ts
let raw = "";
for await (const event of provider.stream(...) as
    AsyncIterable<{ type: string; text?: string }>) {
  if (event.type === "text-delta" && typeof event.text === "string") raw += event.text;
}
const payload = extractJsonObject(raw);
if (!payload) {
  io.stderr("(model output didn't parse as JSON — nothing written. Try rephrasing.)\n");
  process.exitCode = 1; return;
}
```

A provider `error` event (Ollama down, model not pulled —
goal 176's `ollama pull` hint, a 5xx) was iterated past, `raw`
stayed `""`, `extractJsonObject("")` → `undefined`, and the
user was told **"model output didn't parse as JSON — Try
rephrasing."** That is an *actively misleading* diagnostic:
the model never ran, the user's phrasing was fine, and the
real fix (`ollama pull qwen3:8b`) is never shown. The user
wastes time rephrasing a perfectly good "remember my
anniversary is June 3" — strictly worse than ask/brief's
silent-blank because it misdirects.

## Scope

- `apps/cli/src/commands-remember.ts`: replace the bespoke
  text-delta-only loop with the goal-201 `consumeAskStream`
  helper (no-op `onDelta` — `remember` buffers then
  JSON-parses, it doesn't stream to stdout). On `error`:
  `io.stderr("(error: <msg>)\n")`, `process.exitCode = 1`,
  `return` **before** the JSON-parse path, so the actionable
  provider error replaces the wrong "rephrase" message.
  Matches the command's existing `exitCode = 1/2; return`
  style. The successful-extraction path is unchanged.

## Verify

- `pnpm --filter @muse/cli test` — 507 pass (no regression;
  `consumeAskStream`'s 4 direct unit tests from goal 201 cover
  the drain/error contract `remember` now delegates to — no
  new untested logic).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Real-LLM path → dog-fooded on real Qwen (ollama/qwen3:8b,
  reasoning off), `MUSE_USER_MEMORY_FILE` pointed at a temp
  file:
  - `muse remember "my wedding anniversary is on June 3rd"` →
    `+ fact.wedding_anniversary_date = June 3rd` /
    `Remembered 1 item(s)…` — extraction path unchanged.
  - `muse remember "…" --model ollama/nope-7b` → stderr
    `(error: Ollama stream failed with 404: … run \`ollama
    pull nope-7b\` …)`, exit **1** (previously: "model output
    didn't parse as JSON — Try rephrasing.", exit 1).

## Status

done — a failed model request during memory extraction now
surfaces the provider's actionable error instead of blaming
the user's phrasing. `consumeAskStream` now backs `ask`,
`brief`, and `remember`; remaining stream consumers
(`commands-read`, `chat-history`, `chat-repl`, `job-worker`)
stay on the sweep list.
