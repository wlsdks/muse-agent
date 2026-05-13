/**
 * Diagnostic model provider — used by smoke:broad and any test
 * harness that wants a deterministic, no-network ModelProvider.
 * Echoes a canned response shape via `renderDiagnosticOutput`.
 *
 * Extracted from `./index.ts` to keep that file focused on the
 * type surface + the registry. Option interface (and the public
 * `DiagnosticModelProvider` re-export) stays in `./index.ts` so
 * external import paths don't change.
 */

import {
  diagnosticModelCapabilities,
  estimateDiagnosticTokens,
  renderDiagnosticOutput
} from "./provider-wire.js";

import {
  parseModelName,
  type DiagnosticModelProviderOptions,
  type ModelEvent,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse
} from "./index.js";

export class DiagnosticModelProvider implements ModelProvider {
  readonly id: string;
  private readonly defaultModel?: string;
  private readonly models: readonly string[];

  constructor(options: DiagnosticModelProviderOptions = {}) {
    this.id = options.id ?? "diagnostic";
    this.defaultModel = options.defaultModel;
    this.models = options.models ?? [parseModelName(options.defaultModel ?? "diagnostic/smoke").modelId ?? "smoke"];
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.models.map((modelId) => ({
      capabilities: diagnosticModelCapabilities(),
      displayName: `Diagnostic ${modelId}`,
      modelId,
      providerId: this.id
    }));
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const latestUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
    const output = renderDiagnosticOutput(request.messages, latestUserMessage?.content ?? "");

    return {
      id: "diagnostic-response",
      model: request.model || this.defaultModel || `${this.id}/${this.models[0] ?? "smoke"}`,
      output,
      usage: {
        inputTokens: estimateDiagnosticTokens(request.messages.map((message) => message.content).join(" ")),
        outputTokens: estimateDiagnosticTokens(output)
      }
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await this.generate(request);

    if (response.output.length > 0) {
      yield { text: response.output, type: "text-delta" };
    }

    yield { response, type: "done" };
  }
}
