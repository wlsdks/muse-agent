import { parseBoolean } from "@muse/autoconfigure";
import { parseBooleanSetting, type RuntimeSetting } from "@muse/runtime-settings";

export const CONSOLIDATE_IDLE_FLAG = "MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED";
export const CONSOLIDATE_IDLE_FLAG_LABEL = "Idle self-improvement consolidation";

export function resolveConsolidateIdleEnabled(
  env: { readonly [key: string]: string | undefined },
  runtimeSetting: RuntimeSetting | undefined,
  defaultValue = false
): boolean {
  const runtimeValue = runtimeSetting?.type === "boolean"
    ? parseBooleanSetting(runtimeSetting.value)
    : undefined;
  return runtimeValue ?? parseBoolean(env[CONSOLIDATE_IDLE_FLAG], defaultValue);
}
