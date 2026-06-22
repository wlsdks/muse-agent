/**
 * Provider wire-format barrel.
 *
 * The per-provider transforms live in their own focused modules:
 *
 *   - provider-shared.ts: pure JSON shape guards, finite-number
 *     reader, JSON parse-or-undefined, the baseline ModelCapabilities
 *     factories, and `synthesizeStreamEventsFromResponse` (the
 *     non-stream-to-stream replay used by Anthropic + Gemini wrappers).
 *   - provider-anthropic.ts: toAnthropicRequest / fromAnthropicResponse
 *     + parseAnthropicUsage + anthropicModelCapabilities.
 *   - provider-gemini.ts: toGeminiRequest / fromGeminiResponse +
 *     sanitizeGeminiSchema + parseGeminiUsage + geminiModelCapabilities.
 *   - provider-openai.ts: toOpenAIChatRequest / fromOpenAIChatResponse
 *     / toOpenAIResponsesRequest / fromOpenAIResponsesResponse /
 *     parseOpenAIStream / parseOpenAIResponsesStream + their internal
 *     SSE / tool-call merging helpers.
 *   - provider-diagnostic.ts: the diagnostic provider's deterministic-output
 *     helpers (`estimateDiagnosticTokens`, `renderDiagnosticOutput`,
 *     `diagnosticModelCapabilities`).
 *
 * This file re-exports them all so existing consumers (the provider
 * adapter classes in ./index.ts, the test files, downstream packages)
 * keep working through the historical `./provider-wire.js` path.
 */

export {
  anthropicModelCapabilities,
  fromAnthropicResponse,
  toAnthropicRequest
} from "./provider-anthropic.js";

export {
  diagnosticModelCapabilities,
  estimateDiagnosticTokens,
  renderDiagnosticOutput
} from "./provider-diagnostic.js";

export {
  fromGeminiResponse,
  geminiModelCapabilities,
  sanitizeGeminiSchema,
  toGeminiRequest
} from "./provider-gemini.js";

export {
  fromOpenAIChatResponse,
  fromOpenAIResponsesResponse,
  parseOpenAIResponsesStream,
  parseOpenAIStream,
  toOpenAIChatRequest,
  toOpenAIResponsesRequest
} from "./provider-openai.js";

export {
  defaultRemoteModelCapabilities,
  localModelCapabilities,
  synthesizeStreamEventsFromResponse
} from "./provider-shared.js";
