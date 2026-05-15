# 201 — `muse ask` fast path must surface provider errors

## Why

The default `muse ask` path (chat-only fast path, no
`--with-tools`) consumed the model stream with:

```ts
for await (const event of provider.stream(...)) {
  if (signal.aborted) break;
  if (event.type === "text-delta" && typeof event.text === "string") {
    collectedAnswer += event.text;
    if (!options.json) io.stdout(event.text);
  }
}
```

It only handled `text-delta`. A provider **`error`** event —
Ollama not running, **model not pulled** (goal 176 crafted an
actionable `ollama pull <model>` hint for exactly this), a
5xx — was not `text-delta`, so the loop iterated straight
past it, the stream ended, `collectedAnswer` stayed `""`, and
`muse ask` printed nothing then exited **0**. The user got a
silent blank "success" for a failed request, and goal 176's
actionable adapter error never reached them. The
agent-runtime path (`--with-tools`) and `model-loop.ts`
already surface `error` events; the fast path — the default,
most-used path — silently dropped them.

## Scope

- `apps/cli/src/commands-ask.ts`: extract the stream drain
  into an exported `consumeAskStream(events, onDelta,
  isAborted)` returning `{ answer, error? }`. An `error`
  event returns immediately with the accumulated partial
  answer plus `error.message` (or a generic fallback). The
  call site sets `process.exitCode = 1`, writes
  `(error: <message>)` to stderr (same stderr-diagnostic
  convention as the grounded / Ctrl-C banners; goal 175's
  clean-envelope style — no raw stack), and returns before
  the trailing stdout/JSON success block. No behavior change
  for a normal stream.
- `apps/cli/src/commands-ask.test.ts`: 4 direct unit tests —
  delta accumulation + forwarding, error surfaced with the
  partial answer preserved, generic-message fallback when the
  error carries none, abort short-circuit.

## Verify

- `pnpm --filter @muse/cli test` — 507 pass (4 new ×
  src+dist).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Real-LLM path → dog-fooded on real Qwen (ollama/qwen3:8b,
  reasoning off):
  - `muse ask "Reply with exactly: PONG"` → streams `PONG`
    (normal path unchanged).
  - `muse ask "hi" --model ollama/does-not-exist-9b` → now
    prints `(error: Ollama stream failed with 404: … — run
    \`ollama pull does-not-exist-9b\` …)` and **exits 1**
    (previously: blank output, exit 0).

## Status

done — a failed model request on the default `muse ask` path
now surfaces the provider's actionable error (including goal
176's `ollama pull` hint) and exits non-zero, instead of a
silent empty success.
