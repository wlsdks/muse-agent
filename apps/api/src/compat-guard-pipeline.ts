/**
 * Reactor-compat input guard pipeline definition + stage helpers extracted
 * from reactor-compat-routes.ts. Owns the static `inputGuardStages`
 * list (RateLimit / InputValidation / InjectionDetection /
 * Classification / UnicodeNormalization), per-stage runtime-setting
 * overlays, and the simulation entry point that runs through the @muse/policy
 * pipeline using whatever input-guard rules are configured.
 */

import { inputGuardSimulationToJson, simulateInputGuardPipeline } from "@muse/policy";
import type { JsonObject } from "@muse/shared";
import { listInputGuardRules } from "./compat-guard-rule-store.js";
import {
  readBodyString,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export interface CompatGuardStage {
  readonly className: string;
  readonly config: readonly CompatGuardStageField[];
  readonly enabled: boolean;
  readonly name: string;
  readonly order: number;
}

export interface CompatGuardStageField {
  readonly defaultValue: string;
  readonly description: string;
  readonly key: string;
  readonly restartRequired: boolean;
  readonly type: string;
}

export const inputGuardStages: readonly CompatGuardStage[] = [
  {
    className: "RateLimitStage",
    config: [
      {
        defaultValue: "60",
        description: "Requests per minute per user",
        key: "requestsPerMinute",
        restartRequired: true,
        type: "int"
      },
      {
        defaultValue: "1800",
        description: "Requests per hour per user",
        key: "requestsPerHour",
        restartRequired: true,
        type: "int"
      }
    ],
    enabled: true,
    name: "RateLimit",
    order: 0
  },
  {
    className: "InputValidationStage",
    config: [
      {
        defaultValue: "10000",
        description: "Maximum input character length",
        key: "maxLength",
        restartRequired: true,
        type: "int"
      },
      {
        defaultValue: "1",
        description: "Minimum input character length",
        key: "minLength",
        restartRequired: true,
        type: "int"
      }
    ],
    enabled: true,
    name: "InputValidation",
    order: 1
  },
  {
    className: "InjectionDetectionStage",
    config: [
      {
        defaultValue: "medium",
        description: "Prompt injection detection sensitivity",
        key: "sensitivityLevel",
        restartRequired: true,
        type: "enum(low|medium|high)"
      }
    ],
    enabled: true,
    name: "InjectionDetection",
    order: 2
  },
  {
    className: "CompositeClassificationStage",
    config: [
      {
        defaultValue: "false",
        description: "Whether to use LLM classification",
        key: "llmEnabled",
        restartRequired: true,
        type: "bool"
      }
    ],
    enabled: true,
    name: "Classification",
    order: 3
  },
  {
    className: "UnicodeNormalizationStage",
    config: [
      {
        defaultValue: "0.1",
        description: "Allowed ratio of zero-width characters",
        key: "maxZeroWidthRatio",
        restartRequired: true,
        type: "float"
      }
    ],
    enabled: true,
    name: "UnicodeNormalization",
    order: 4
  }
];

export async function toGuardStageResponse(
  stage: CompatGuardStage,
  options: ReactorCompatibilityRouteOptions
): Promise<JsonObject> {
  return {
    className: stage.className,
    enabled: stage.enabled,
    name: stage.name,
    order: await options.runtimeSettings.getInteger(`guard.stage.${stage.name}.order`, stage.order),
    runtimeOverride: await runtimeSettingStringOrNull(options, `guard.stage.${stage.name}.enabled`)
  };
}

export async function stageConfigResponse(
  stage: CompatGuardStage,
  options: ReactorCompatibilityRouteOptions
): Promise<JsonObject> {
  const config: Record<string, JsonObject> = {};

  for (const field of stage.config) {
    const value = await runtimeSettingStringOrNull(options, `guard.stage.${stage.name}.${field.key}`);
    config[field.key] = {
      default: field.defaultValue,
      description: field.description,
      overridden: value !== null,
      restartRequired: field.restartRequired,
      type: field.type,
      value: value ?? field.defaultValue
    };
  }

  return {
    className: stage.className,
    config,
    enabled: stage.enabled,
    note: stage.config.length === 0 ? "This stage has no exposed tunable parameters." : null,
    order: await options.runtimeSettings.getInteger(`guard.stage.${stage.name}.order`, stage.order),
    stageName: stage.name
  };
}

async function runtimeSettingStringOrNull(
  options: ReactorCompatibilityRouteOptions,
  key: string
): Promise<string | null> {
  const setting = await options.runtimeSettings.find(key);
  return setting?.value && setting.value.trim().length > 0 ? setting.value : null;
}

export async function simulateGuard(value: unknown, options: ReactorCompatibilityRouteOptions) {
  const input = readBodyString(value, "input")
    ?? readBodyString(value, "text")
    ?? readBodyString(value, "message")
    ?? "";
  return inputGuardSimulationToJson(await simulateInputGuardPipeline({
    input,
    ruleStore: {
      listInputRules: () => listInputGuardRules(options)
    }
  }));
}
