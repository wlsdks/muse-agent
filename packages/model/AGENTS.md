# `@muse/model` — the only place a vendor SDK may appear

`agent-core` calls a Muse-owned `ModelProvider` abstraction, never a vendor SDK. Provider
packages may be imported **only** inside `src/adapter-<name>.ts` — that file naming is the
boundary, not a convention. OpenAI Agents SDK, Vercel AI SDK and LangGraph may be studied; none
may own a Muse contract.

Three things a reader guesses wrong. OpenAI uses the Responses API (`/v1/responses`), while
OpenRouter and LM Studio use `/v1/chat/completions` through `OpenAICompatibleProvider` — and
"LM Studio" is that adapter pointed at a local `baseUrl`, not a class of its own.

**Ollama is NOT on the compat path**, even though it extends the same base. `adapter-ollama.ts`
overrides `generate` and `stream` onto the native `/api/chat`, stripping `/v1` from the URL; only
`listModels` stays on `/v1`. The override is load-bearing, not tidiness: the compat endpoint
ignores `think: false`, so a reasoning model streams its thoughts and first-token latency went to
134 s. Do not "simplify" it back onto the shared path.

Degrade explicitly, never silently: no native tool calling falls back to a strict-parsed text
protocol, no structured output falls back to parser + validator, and `ModelProviderError.retryable`
is the single source of truth for retries — a 4xx like model-not-found must fail fast.

Under `MUSE_LOCAL_ONLY=true` the router **throws** `LocalOnlyViolationError` before instantiating
a cloud provider. That is a hard fail, not a quiet disable, and it is code — do not move it into
prompt text.

Full contract: [`.claude/rules/engineering/architecture.md`](../../.claude/rules/engineering/architecture.md).
Repository-wide brief: [`AGENTS.md`](../../AGENTS.md).
