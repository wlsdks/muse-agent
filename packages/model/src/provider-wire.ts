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

import { escapeRegex } from "@muse/shared";
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
 *     plan. Resolution order:
 *       1. an explicit STEERING DIRECTIVE in the user prompt
 *          (`DIAGNOSTIC_PLAN=[{tool,args,description}, …]` as the trailing
 *          segment) → emit exactly those steps. This lets a terminal-state /
 *          trajectory eval drive the FULL plan-execute assembly against an
 *          arbitrary (incl. state-mutating) tool deterministically, with no
 *          real LLM. The steps are emitted verbatim so the assembly's own
 *          `validatePlan` still runs (an unavailable tool is rejected there,
 *          not silently dropped here).
 *       2. else if `time_now` is listed in `[Available Tools]` → a one-step
 *          plan calling it (the legacy smoke:broad behaviour).
 *       3. else an empty plan that falls through to direct-answer synthesis.
 *
 * Anything else falls through to the legacy "Diagnostic response: …" shape.
 */
export function renderDiagnosticOutput(messages: readonly { readonly role: string; readonly content: string }[], userPrompt: string): string {
  const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
  if (isDiagnosticPlanningPrompt(systemPrompt)) {
    const steered = extractDiagnosticPlanDirective(userPrompt);
    if (steered !== null) {
      return JSON.stringify(steered);
    }
    if (planningPromptListsTool(systemPrompt, "time_now")) {
      return JSON.stringify([
        { args: {}, description: "Diagnostic plan-execute step (time_now)", tool: "time_now" }
      ]);
    }
    return "[]";
  }
  return `Diagnostic response: ${userPrompt}`.trimEnd();
}

const DIAGNOSTIC_PLAN_DIRECTIVE = "DIAGNOSTIC_PLAN=";

interface DiagnosticPlanStep {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly description: string;
}

function isDiagnosticPlanStep(value: unknown): value is DiagnosticPlanStep {
  if (!value || typeof value !== "object") return false;
  const step = value as Partial<DiagnosticPlanStep>;
  return typeof step.tool === "string" && step.tool.length > 0
    && typeof step.description === "string"
    && !!step.args && typeof step.args === "object" && !Array.isArray(step.args);
}

/**
 * Parses a steering directive from the trailing segment of the user prompt.
 * Returns the directed steps, or null when no well-formed directive is present
 * (so the caller falls through to the default planning behaviour). The JSON
 * array must be the LAST segment after the `DIAGNOSTIC_PLAN=` marker.
 */
function extractDiagnosticPlanDirective(userPrompt: string): readonly DiagnosticPlanStep[] | null {
  const at = userPrompt.lastIndexOf(DIAGNOSTIC_PLAN_DIRECTIVE);
  if (at < 0) return null;
  const raw = userPrompt.slice(at + DIAGNOSTIC_PLAN_DIRECTIVE.length).trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(isDiagnosticPlanStep)) {
      return parsed as readonly DiagnosticPlanStep[];
    }
  } catch {
    // not a well-formed directive — fall through to default planning
  }
  return null;
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

