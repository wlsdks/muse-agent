# 204 — `muse read --ask` must surface provider errors

## Why

Continuing the goal 201/202/203 error-swallow sweep.
`muse read <pdf> --ask "<q>"` streams an LLM answer grounded
in the PDF text. Its drain was the same text-delta-only loop
as goal 201's `muse ask` fast path (identical shape:
`withSigintAbort` + onDelta-to-stdout + `--json`):

```ts
for await (const event of provider.stream(...) as
    AsyncIterable<{ type: string; text?: string }>) {
  if (signal.aborted) break;
  if (event.type === "text-delta" && typeof event.text === "string") {
    answer += event.text;
    if (!options.json) io.stdout(event.text);
  }
}
```

A provider `error` event (Ollama down, model not pulled —
goal 176's `ollama pull` hint, a 5xx) was iterated past,
`answer` stayed `""`, and `muse read --ask` printed nothing
(or `{"answer":""}` under `--json`) and exited **0** — a
silent empty answer for a failed request, goal 176's
actionable hint lost.

## Scope

- `apps/cli/src/commands-read.ts`: replace the bespoke
  text-delta-only loop with the goal-201 `consumeAskStream`
  helper (onDelta → stdout unless `--json`; abort via the
  existing `withSigintAbort` signal). On `error`: stderr
  `(error: <msg>)`, `process.exitCode = 1`, `return` before
  the trailing `--json`/newline block — identical to goal
  201's surfacing and matching the command's own existing
  `exitCode = 2; return` precondition style. The normal
  PDF-grounded stream (and PDF parsing, untouched) is
  unchanged.

## Verify

- `pnpm --filter @muse/cli test` — 507 pass (no regression;
  `consumeAskStream`'s 4 direct unit tests from goal 201 cover
  the drain/error contract `read` now delegates to — no new
  untested logic).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Real-LLM path → dog-fooded on real Qwen (ollama/qwen3:8b,
  reasoning off) with a generated minimal PDF containing
  "The capital of France is Paris.":
  - `muse read x.pdf --ask "What is the capital of France?"`
    → `The capital of France is 'Paris'.` — PDF-grounded
    answer path unchanged.
  - `muse read x.pdf --ask "hi" --model ollama/nope-7b` →
    stdout empty, stderr `(error: Ollama stream failed with
    404: … run \`ollama pull nope-7b\` …)`, exit **1**
    (previously: silent empty answer, exit 0).

## Status

done — `muse read --ask` surfaces the provider's actionable
error and exits non-zero on a failed model request instead of
a silent empty answer. `consumeAskStream` now backs `ask`,
`brief`, `remember`, and `read`; `job-worker`, `chat-history`,
and `chat-repl` remain on the sweep list.
