# @muse/model

The `ModelProvider` abstraction and its concrete adapters. It owns the vendor boundary: every
LLM call in Muse goes through the types and provider classes defined here, and this is the
only package permitted to hold a vendor SDK.

## Public surface

- `ModelProvider`, `ModelRequest`, `ModelResponse`, `ModelMessage`, `ModelTool`,
  `ModelCapabilities`, `ModelEvent` — the core provider contract (`generate`, `stream`,
  `listModels`, optional `probeCapabilities`/`resolveContextWindow`).
- `ModelProviderRegistry`, `parseModelName`, `knownModelPrefixes` — provider lookup/routing
  by `provider/model` name, with prefix-based provider inference.
- `OpenAIProvider`, `OpenRouterProvider`, `AnthropicProvider`, `GeminiProvider`,
  `OllamaProvider`, `OpenAICompatibleProvider`, `DiagnosticModelProvider`, `CodexCliProvider`
  — the shipped adapters, one per required provider family.
- `ModelProviderError`, `isRetryableHttpStatus` — the retry-classification source of truth
  (4xx fails fast, 5xx/unknown may retry).
- `classifyProviderLocality`, `isLocalOnlyEnabled`, `LocalOnlyViolationError` — the
  `MUSE_LOCAL_ONLY` fail-close gate against cloud egress.
- `evaluateWebEgressPosture`, `isWebEgressAllowed` — web-search egress policy.
- `MODEL_CATALOG`, `catalogModelsByCapability`, `findCatalogModel` — the static model catalog.
- `sanitizeGeminiSchema` — strips JSON-Schema keywords Gemini's tool API rejects.

## Depends on

- `@muse/shared` — shared `JsonObject`/`JsonValue` types used across every provider request.

## Rules that bind this package

- [`../../.claude/rules/architecture.md`](../../.claude/rules/architecture.md) — this is the ONLY place a vendor SDK/HTTP client may
  appear; the required provider families, fallback rules (no hidden retry magic), retry
  classification, and `MUSE_LOCAL_ONLY` gate are all defined and enforced here.

## Tests

```bash
pnpm --filter @muse/model test
```
