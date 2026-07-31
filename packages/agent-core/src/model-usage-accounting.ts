import type { ModelUsage } from "@muse/model";

export type TerminalModelUsageAccounting =
  | {
      readonly state: "unobserved";
    }
  | {
      readonly state: "recorded";
      readonly usage: Required<ModelUsage>;
    }
  | {
      readonly state: "unknown";
    };

const ZERO_USAGE: Required<ModelUsage> = Object.freeze({
  cachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0
});

export function createTerminalModelUsageAccounting(): TerminalModelUsageAccounting {
  return { state: "unobserved" };
}

export function observeTerminalModelUsage(
  current: TerminalModelUsageAccounting,
  usage: ModelUsage | undefined
): TerminalModelUsageAccounting {
  if (current.state === "unknown") return current;
  if (!usage || !hasObservedUsage(usage)) return { state: "unknown" };
  const values = [
    usage.cachedInputTokens,
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningTokens
  ];
  if (values.some((value) => value !== undefined && !isSafeTokenCount(value))) {
    return { state: "unknown" };
  }
  const accumulated = current.state === "recorded" ? current.usage : ZERO_USAGE;
  return {
    state: "recorded",
    usage: {
      cachedInputTokens: saturatingAdd(
        accumulated.cachedInputTokens,
        usage.cachedInputTokens ?? 0
      ),
      inputTokens: saturatingAdd(accumulated.inputTokens, usage.inputTokens ?? 0),
      outputTokens: saturatingAdd(accumulated.outputTokens, usage.outputTokens ?? 0),
      reasoningTokens: saturatingAdd(
        accumulated.reasoningTokens,
        usage.reasoningTokens ?? 0
      )
    }
  };
}

export function terminalModelUsage(
  accounting: TerminalModelUsageAccounting | undefined
): ModelUsage | undefined {
  return accounting?.state === "recorded" ? accounting.usage : undefined;
}

function hasObservedUsage(usage: ModelUsage): boolean {
  return usage.cachedInputTokens !== undefined
    || usage.inputTokens !== undefined
    || usage.outputTokens !== undefined
    || usage.reasoningTokens !== undefined;
}

function isSafeTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function saturatingAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}
