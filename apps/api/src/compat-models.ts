/**
 * Reactor-compat model registry helpers extracted from
 * reactor-compat-routes.ts. Covers /api/sessions/models (the dropdown
 * source for the chat surface) and the agent-mode normalizers
 * (parseAgentMode, agentModeResponse).
 */

import type { AgentSpecInput } from "@muse/agent-specs";
import type { ReactorCompatibilityRouteOptions } from "./reactor-compat-routes.js";

export async function listSessionModels(options: ReactorCompatibilityRouteOptions) {
  const models = await options.modelProvider?.listModels();
  const names = models && models.length > 0
    ? models.map((model) => `${model.providerId}/${model.modelId}`)
    : options.defaultModel ? [options.defaultModel] : [];
  const defaultModel = options.defaultModel ?? names[0] ?? "";

  return {
    defaultModel,
    models: names.map((name) => ({ isDefault: name === defaultModel, name }))
  };
}

export function parseAgentMode(value: unknown): AgentSpecInput["mode"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "standard" || normalized === "plan_execute" || normalized === "react" ? normalized : undefined;
}

export function agentModeResponse(value: AgentSpecInput["mode"]): string {
  return value === "plan_execute" ? "PLAN_EXECUTE" : (value ?? "react").toUpperCase();
}
