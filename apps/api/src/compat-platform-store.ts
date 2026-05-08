/**
 * Reactor-compat platform pricing + alert-rule store helpers extracted
 * from reactor-compat-routes.ts.
 *
 * Each helper dispatches to the configured admin store (options.admin.pricingStore
 * or options.admin.alertRuleStore) when present, otherwise falls back to the
 * file-private compat state via accessors. Pairs with
 * admin-platform-compat-routes.ts (POST/GET /api/admin/platform/pricing)
 * and admin-tenant-alert-compat-routes.ts (the /api/admin/platform/alerts/*
 * surface).
 */

import type { PlatformAlertRule, PlatformModelPricing } from "@muse/runtime-state";
import type { JsonObject } from "@muse/shared";
import {
  createRecord,
  getStatePlatformAlertRules,
  getStatePlatformPricing,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export async function listPlatformPricing(options: ReactorCompatibilityRouteOptions): Promise<readonly JsonObject[]> {
  if (options.admin?.pricingStore) {
    return (await options.admin.pricingStore.list()).map(platformPricingToJson);
  }

  return [...getStatePlatformPricing().values()].sort((left, right) =>
    String(right.effectiveFrom ?? right.createdAt).localeCompare(String(left.effectiveFrom ?? left.createdAt))
  );
}

export async function savePlatformPricing(
  options: ReactorCompatibilityRouteOptions,
  input: JsonObject
): Promise<JsonObject> {
  if (options.admin?.pricingStore) {
    return platformPricingToJson(await options.admin.pricingStore.save(input as unknown as PlatformModelPricing));
  }

  return createRecord(getStatePlatformPricing(), input, "model_pricing");
}

export async function listPlatformAlertRules(options: ReactorCompatibilityRouteOptions): Promise<readonly JsonObject[]> {
  if (options.admin?.alertRuleStore) {
    return (await options.admin.alertRuleStore.list()).map(platformAlertRuleToJson);
  }

  return [...getStatePlatformAlertRules().values()];
}

export async function savePlatformAlertRule(
  options: ReactorCompatibilityRouteOptions,
  input: JsonObject
): Promise<JsonObject> {
  if (options.admin?.alertRuleStore) {
    return platformAlertRuleToJson(await options.admin.alertRuleStore.save(input as unknown as PlatformAlertRule));
  }

  return createRecord(getStatePlatformAlertRules(), input, "alert_rule");
}

export async function deletePlatformAlertRule(options: ReactorCompatibilityRouteOptions, id: string): Promise<boolean> {
  if (options.admin?.alertRuleStore) {
    return options.admin.alertRuleStore.delete(id);
  }

  return getStatePlatformAlertRules().delete(id);
}

function platformPricingToJson(pricing: PlatformModelPricing): JsonObject {
  return {
    batchCompletionPricePer1k: pricing.batchCompletionPricePer1k,
    batchPromptPricePer1k: pricing.batchPromptPricePer1k,
    cachedInputPricePer1k: pricing.cachedInputPricePer1k,
    completionPricePer1k: pricing.completionPricePer1k,
    createdAt: pricing.createdAt ?? pricing.effectiveFrom,
    effectiveFrom: pricing.effectiveFrom,
    effectiveTo: pricing.effectiveTo ?? null,
    id: pricing.id,
    model: pricing.model,
    promptPricePer1k: pricing.promptPricePer1k,
    provider: pricing.provider,
    reasoningPricePer1k: pricing.reasoningPricePer1k,
    updatedAt: pricing.updatedAt ?? pricing.effectiveFrom
  };
}

function platformAlertRuleToJson(rule: PlatformAlertRule): JsonObject {
  return {
    createdAt: rule.createdAt,
    description: rule.description,
    enabled: rule.enabled,
    id: rule.id,
    metric: rule.metric,
    name: rule.name,
    platformOnly: rule.platformOnly,
    severity: rule.severity,
    tenantId: rule.tenantId ?? null,
    threshold: rule.threshold,
    type: rule.type,
    windowMinutes: rule.windowMinutes
  };
}
