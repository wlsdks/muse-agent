/**
 * Provider wire-format barrel.
 *
 * The bulk of the per-provider transforms now live in their own
 * focused modules:
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
 *
 * This file re-exports them all so existing consumers (the provider
 * adapter classes in ./index.ts, the test files, downstream packages)
 * keep working through the historical `./provider-wire.js` path. It
 * also owns the diagnostic-provider's deterministic-output helpers
 * (`estimateDiagnosticTokens`, `renderDiagnosticOutput`,
 * `diagnosticModelCapabilities`) — those are only used by the
 * diagnostic provider so they don't deserve their own file yet.
 */

import type { ModelCapabilities } from "./index.js";
import { localModelCapabilities } from "./provider-shared.js";

export {
  anthropicModelCapabilities,
  fromAnthropicResponse,
  toAnthropicRequest
} from "./provider-anthropic.js";

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

export function diagnosticModelCapabilities(): ModelCapabilities {
  return {
    ...localModelCapabilities(),
    maxInputTokens: 32_000,
    maxOutputTokens: 4_096,
    structuredOutput: true,
    toolCalling: false
  };
}

export function estimateDiagnosticTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

/**
 * Shapes the diagnostic provider's deterministic output. The default behavior
 * is "Diagnostic response: <user prompt>", but a structural mode hint in the
 * system messages lets smoke tests exercise plan-execute without a real LLM:
 *
 *   - planning prompts (built by `buildPlanningSystemPrompt`) → emit a JSON
 *     plan. If `time_now` is listed in `[Available Tools]` the diagnostic
 *     emits a one-step plan calling it (so the smoke can assert the
 *     plan_step_executing + plan_step_result events); otherwise it emits an
 *     empty plan that falls through to the direct-answer synthesis path.
 *
 * Anything else falls through to the legacy "Diagnostic response: …" shape.
 */
export function renderDiagnosticOutput(messages: readonly { readonly role: string; readonly content: string }[], userPrompt: string): string {
  const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
  if (isDiagnosticPlanningPrompt(systemPrompt)) {
    if (planningPromptListsTool(systemPrompt, "time_now")) {
      return JSON.stringify([
        { args: {}, description: "Diagnostic plan-execute step (time_now)", tool: "time_now" }
      ]);
    }
    return "[]";
  }
  return `Diagnostic response: ${userPrompt}`.trimEnd();
}

function isDiagnosticPlanningPrompt(systemPrompt: string): boolean {
  return systemPrompt.includes("[Role]")
    && systemPrompt.includes("[Output Format]")
    && systemPrompt.includes("[Available Tools]");
}

function planningPromptListsTool(systemPrompt: string, toolName: string): boolean {
  // Tools are rendered by renderToolDescriptionsForPlanning as `- <name>: <description>`.
  return new RegExp(`(^|\\n)\\s*-\\s*${escapeRegex(toolName)}\\s*:`, "u").test(systemPrompt);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
