import { ModelProviderError } from "./provider-base.js";
import type { ModelContextWindowResolution, ModelProvider } from "./index.js";

export type ModelContextBudgetErrorCode = "CONTEXT_BUDGET_EXCEEDED" | "STATE_UNAVAILABLE";

export class ModelContextBudgetError extends ModelProviderError {
  readonly code: ModelContextBudgetErrorCode;

  constructor(providerId: string, code: ModelContextBudgetErrorCode) {
    super(
      providerId,
      code === "CONTEXT_BUDGET_EXCEEDED"
        ? "local model request exceeds the effective context budget"
        : "local model context admission state is unavailable",
      false
    );
    this.name = "ModelContextBudgetError";
    this.code = code;
  }
}

class ModelContextWindowCancelledError extends ModelProviderError {
  constructor(providerId: string) {
    super(providerId, "model context window request cancelled by the caller", false);
    this.name = "ModelContextWindowCancelledError";
  }
}

export function isModelContextWindowCancelledError(error: unknown): error is ModelProviderError {
  return error instanceof ModelContextWindowCancelledError;
}

function cancelled(providerId: string): ModelProviderError {
  return new ModelContextWindowCancelledError(providerId);
}

/**
 * Wait for shared provider-window authority without letting one caller cancel
 * or poison the provider's process-lifetime probe promise.
 */
export async function awaitModelContextWindow(
  provider: ModelProvider,
  model: string,
  signal?: AbortSignal
): Promise<ModelContextWindowResolution | undefined> {
  if (signal?.aborted) throw cancelled(provider.id);
  const resolver = provider.resolveContextWindow;
  if (!resolver) return undefined;
  const pending = resolver.call(provider, model);
  if (!signal) return pending;

  return new Promise<ModelContextWindowResolution>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => reject(cancelled(provider.id)));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void pending.then(
      (value) => finish(() => signal.aborted ? reject(cancelled(provider.id)) : resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}
