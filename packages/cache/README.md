# @muse/cache

Response caching for agent turns: an in-memory `ResponseCache` with pattern-based invalidation,
deterministic cache-key/scope-fingerprint construction, provider-aware prompt-caching
(`PromptCache`, currently an Anthropic-specific implementation plus a no-op), and cache
cost/health metrics.

## Public surface

- `.` (`src/index.ts`) — `ResponseCache` and its implementations (`InMemoryResponseCache`,
  `NoOpResponseCache`), `buildCacheKey`/`buildScopeFingerprint`/`normalizeCacheText`,
  `cacheableModelRequest`/`cachedResponseFromModelResponse`, `PromptCache` and its
  implementations (`AnthropicPromptCache`, `NoOpPromptCache`), and re-exported metrics
  (`InMemoryCacheStatsStore`, `InMemoryCacheMetricsRecorder`, `NoOpCacheMetricsRecorder`,
  `estimateCostUsd`, `resolveProvider`, `isLocalProvider`).

## Depends on

- `@muse/model` — cache keys and prompt-caching options are typed against `ModelRequest`/
  `ModelResponse`.
- `@muse/shared` — `escapeRegex`, `JsonObject`/`JsonValue`.

## Rules that bind this package

- `AnthropicPromptCache` is provider-specific by design (Anthropic's native prompt-caching
  header shape) but stays behind the vendor-neutral `PromptCache` interface, per
  `../../.claude/rules/engineering/architecture.md` — no vendor SDK belongs in this package.
- Cache keys fold in identity/session scope (`resolveIdentityScope`, `stringMetadata`) so a
  cached response for one user/session is never served to another.

## Tests

`pnpm --filter @muse/cache test`
