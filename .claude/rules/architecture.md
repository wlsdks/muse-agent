# Architecture rules

## Model-agnostic core

`agent-core` calls a Muse-owned abstraction — never a vendor SDK directly.

```ts
interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

Each model declares its capabilities so the runtime can route safely:

- `streaming`, `toolCalling`, `structuredOutput`, `vision`, `reasoning`, `promptCaching`
- `maxInputTokens`, `maxOutputTokens`
- `local`, `cost`, `latencyProfile`

## Required provider families

`packages/model` ships adapters for:

- OpenAI (Responses API — `/v1/responses`). OpenAI-compatible endpoints
  used by Ollama, OpenRouter, LM Studio, and other compat backends still
  use `/v1/chat/completions` via `OpenAICompatibleProvider`.
- Anthropic
- Google Gemini
- OpenRouter
- Ollama
- LM Studio / OpenAI-compatible local
- Custom OpenAI-compatible endpoint

## Fallback rules

- If native tool calling is unavailable → fall back to a text tool protocol with strict parsing.
- If structured output is unavailable → fall back to parser + validator.
- If the context window is small → apply stronger trimming before invocation.
- If a provider fails → use the explicit fallback policy. **No hidden retry magic.**
- Retry classification: `ModelProviderError.retryable` is the source of truth.
  4xx (model-not-found, bad key) MUST fail fast. 5xx and unknown errors MAY retry.

## Local-only mode (no cloud egress) — opt-in

`MUSE_LOCAL_ONLY=true` is the OPT-IN privacy/security posture for running
Muse strictly on local open-source models — nothing may reach a third-party
cloud LLM/voice API. It is **off by default** (cloud is allowed); when
switched on it is deterministic, fail-close (`local-only-policy.ts`):

- `classifyProviderLocality(providerId, effectiveBaseUrl)` is the source
  of truth. Local = `ollama` / `lmstudio` / `diagnostic` on a loopback
  host, or an `openai-compatible` endpoint pointed at localhost. Cloud =
  any cloud-id provider (`openai`/`anthropic`/`gemini`/`openrouter`) OR an
  off-box host — a REMOTE Ollama/LM-Studio host counts as egress.
- The model router (`createModelProvider`) throws `LocalOnlyViolationError`
  (loud, not a silent disable) before instantiating a cloud provider.
- **Default model resolution.** Priority: explicit `MUSE_MODEL`/
  `MUSE_DEFAULT_MODEL` env → local-only forced local → the user's saved
  `defaultModel` in `~/.config/muse/config.json` → a cloud model inferred
  from an ambient credential (GEMINI → OPENAI → ANTHROPIC → OPENROUTER) →
  the local fallback (`ollama/gemma4:12b`, so a fresh box still boots).
  The config rung exists because a stale ambient key must never beat the
  user's explicit choice (dead-GEMINI hijack, fixed 2026-07-17). When `MUSE_LOCAL_ONLY=true`, the local model is forced and ambient
  cloud keys are IGNORED (so a stray `GEMINI_API_KEY` can never trip the gate).
- When local-only is on, the voice registry ignores an OpenAI key, so cloud
  STT/TTS never registers (mic audio cannot silently go to OpenAI).
- `muse doctor` reports the posture; embeddings are already localhost-only.
- **Image input needs no separate guard**: there is no standalone vision
  provider. `muse vision` is Ollama-local by design, agent-run attachments
  are text-only, and image bytes only leave via a cloud provider's adapter
  — which the model-router gate already forbids under local-only. So the
  provider gate transitively closes vision egress; don't add a second one.

## What's allowed inside adapters

- Vendor SDK provider packages MAY be used inside `packages/model/src/adapters/<name>.ts`.
- They MUST NOT become the core runtime API.
- OpenAI Agents SDK, Vercel AI SDK, LangGraph.js may be studied but must not own Muse contracts.

## MCP server allowlist (goal 032)

`McpSecurityPolicy.allowedServerNames` controls which external MCP
server names are eligible for connection. Enforcement is two-layered:

- At register time, `McpManager.register` checks the allowlist + marks
  a denied server `disabled` without throwing.
- At connect time, `McpManager.connect` re-checks via
  `securityPolicyProvider.isServerAllowed(name)` so a policy change
  between register and connect still gates correctly. Returns `false`
  + status `"disabled"` on denial — no exception.

Empty `allowedServerNames` means everything's allowed (opt-in
posture). Populate it when you need a strict allowlist (multi-MCP
machines, shared workstations).

## Provider-specific schema quirks

- **Gemini**: tool inputSchemas pass through `sanitizeGeminiSchema` to strip
  JSON-Schema keywords Gemini's tool API rejects (`additionalProperties`,
  `$schema`, `$id`, `$ref`, `definitions`, `patternProperties`,
  `unevaluatedProperties`, `exclusiveMinimum`, `exclusiveMaximum`).
- **OpenAI strict mode**: requires `additionalProperties: false`. Don't strip it for that path.
- **Anthropic**: accepts standard JSON Schema with `additionalProperties: false`.

## Database

- PostgreSQL is the source of truth for server state.
- Kysely is used for typed SQL access.
- Prefer explicit SQL migrations over ORM-managed schema mutation.
- Run, message, tool-call, approval, checkpoint, and trace tables stay queryable.
- Don't hide critical agent state in opaque blobs unless it's an append-only event payload.

## Build graph (TypeScript project references)

Every TS workspace (all `packages/*` plus `apps/cli` / `apps/api`) is a
`composite` project and declares `references` to its internal `@muse/*`
dependencies; the root `tsconfig.json` is a solution file referencing them
all. Each package's `build` script is `tsc -b`, so an isolated
`pnpm --filter @muse/<x> build` rebuilds stale upstream `dist/` first — the
build graph is dependency-correct, not reliant on pnpm's topological order
alone. This is what closes the recurring "stale dist" failure class.

- A new internal dependency MUST be added to BOTH `package.json` and the
  project's `tsconfig.json` `references` (a Zod-style fail if you forget:
  `tsc -b` won't see the dep's fresh `.d.ts`). The acyclic invariant holds —
  do not introduce a reference cycle.
- `apps/web` is intentionally OUT of the reference graph (Vite island, no
  `@muse/*` deps); keep its `tsc -p tsconfig.json && vite build` script.

## Coding rules

- Core packages stay framework-independent.
- TypeScript strict mode.
- Zod (or comparable) for external input + config validation.
- Prefer small interfaces and explicit adapters over global service locators.
- Don't add framework abstractions until a real module boundary needs them.
- Snapshot-test prompt text and tool protocols when behavior matters.
- No provider-specific assumptions in `agent-core`.
- Deterministic code for policy, permissions, budgets, and stop conditions.
