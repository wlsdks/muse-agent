# 273 — first-run wizard steered Ollama users to a localhost URL that breaks on IPv6

## Why

Sibling of goal 259 (which fixed `muse doctor`'s divergent
`localhost` Ollama default). `muse setup model` — the first-run
wizard that persists `~/.muse/models.json` — listed the Ollama
provider with:

```ts
{ id: "ollama", envKey: "OLLAMA_BASE_URL", secret: false,
  placeholderHint: "http://localhost:11434", … }
```

`placeholderHint` is shown both in the prompt message and as the
`text()` placeholder; the `validate` rejects empty input, so the
user must **type a value** — and the obvious thing to type is the
hint. Following the wizard's own suggestion persists
`OLLAMA_BASE_URL=http://localhost:11434`. On an IPv6-enabled host
`localhost` resolves to `::1` first while Ollama binds IPv4
`127.0.0.1`, so every subsequent call (RAG embeddings, chat,
`muse doctor`) gets ECONNREFUSED — a brand-new user follows the
setup wizard exactly and lands on a phantom "Ollama unreachable".
The runtime's canonical resolver (`resolveOllamaUrl()`, the value
goal 259 standardised on) defaults to `http://127.0.0.1:11434`;
the wizard hint should match it. Ollama is also the loop's
mandated Qwen path, so this is the critical first-run surface.

## Scope

`apps/cli/src/setup-model.ts`:

- Change the Ollama provider spec's `placeholderHint` from
  `http://localhost:11434` to `http://127.0.0.1:11434`, matching
  the runtime canonical default and the `commands-setup-local`
  docs. One data string; a one-line WHY comment records the IPv6
  rationale. No logic, flow, or persistence change (the hint is
  display-only — the user still types/edits the value).

`suggestedModel: "ollama/llama3.2"` is left as-is — the wizard is
provider-neutral and the suggested model is a product default,
not a correctness bug.

## Verify

- `pnpm --filter @muse/cli test` — 561 pass (was 560; +1). New
  test asserts the exported `SETUP_MODEL_PROVIDER_SPECS` Ollama
  entry's `placeholderHint` is exactly `http://127.0.0.1:11434`
  and does not contain `localhost` (regression guard locking the
  hint to the canonical default that `resolveOllamaUrl`'s own
  test, program.test.ts:6267, already pins). All other CLI tests
  stay green.
- `pnpm check` — every workspace green (apps/cli 561, apps/api
  160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (a setup-wizard
  display-hint data string). The deterministic spec assertion is
  the rigorous verification — an interactive-prompt round-trip
  would add no signal over pinning the data.

## Status

done — `muse setup model` now suggests `http://127.0.0.1:11434`
for Ollama, so a new user following the wizard configures the
address the runtime actually talks to instead of an
IPv6-`localhost` value that silently refuses. The localhost
divergence is now closed across both the diagnostic (`doctor`,
259) and the configuration (`setup model`, 273) surfaces.
