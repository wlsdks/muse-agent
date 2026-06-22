/**
 * Hook orchestration extracted from AgentRuntime.
 *
 * Hooks are extension points: every registered HookStage gets a chance to
 * react to lifecycle events (beforeStart, beforeTool, afterTool,
 * afterComplete, onError). They MUST fail open — a thrown hook only records
 * a `failed` trace, never aborts the run.
 *
 * The HookTraceStore captures per-invocation success / failure metadata so
 * operators can audit which hooks ran for any given run.
 */

import type { ModelResponse, ModelToolCall } from "@muse/model";
import type { ToolExecutionResult } from "@muse/tools";
import type { Awaitable } from "@muse/cache";
import type { HookLifecycle, HookTraceStore } from "@muse/runtime-state";
import type { AgentRunContext, HookStage } from "./types.js";

/** Mirror of the runtime's pluggable hook registry surface. */
interface HookRegistryLike {
  list(): readonly HookStage[];
}

interface InvokeHooksDeps {
  readonly hooks: readonly HookStage[];
  readonly hookRegistry?: HookRegistryLike;
  readonly hookTraceStore?: HookTraceStore;
  /**
   * Per-hook wall-clock bound. Hooks fail OPEN on a throw, but a hook that
   * HANGS (an await that never settles) would block the agent loop forever —
   * fail-open must cover that too. Defaults to DEFAULT_HOOK_TIMEOUT_MS; a hook
   * exceeding it is recorded as a `failed` trace and the loop moves on (the
   * hook promise keeps running detached — hooks are reactive, never gates, so
   * proceeding is safe). Set <=0 / non-finite to disable.
   */
  readonly hookTimeoutMs?: number;
}

/** Default per-hook timeout — generous, so only a pathological hang is cut. */
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

async function invokeWithTimeout(invoke: () => Awaitable<void>, timeoutMs: number): Promise<void> {
  const work = (async () => { await invoke(); })();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    await work;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`hook exceeded ${timeoutMs.toString()}ms timeout`)), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    // A late rejection of `work` after the timeout wins is still observed by
    // race's attached handler, so it never surfaces as an unhandled rejection.
    await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type InvokeHookValue<Name extends keyof HookStage> =
  Name extends "beforeTool" ? ModelToolCall :
  Name extends "afterTool" ? { readonly result: ToolExecutionResult; readonly toolCall: ModelToolCall } :
  Name extends "afterComplete" ? ModelResponse :
  Name extends "onError" ? unknown :
  never;

/**
 * Fires the named lifecycle on every registered HookStage. Static `hooks` and
 * dynamic `hookRegistry.list()` entries are merged by id (registry wins on
 * collision so it can override a startup-wired hook). Each hook invocation is
 * traced when a HookTraceStore is configured; failures are demoted to a
 * `failed` trace and swallowed so the agent loop is never blocked.
 */
export async function invokeHooks<Name extends keyof HookStage>(
  name: Name,
  context: AgentRunContext,
  deps: InvokeHooksDeps,
  value?: InvokeHookValue<Name>
): Promise<void> {
  const timeoutMs = deps.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  for (const hook of mergedHooks(deps)) {
    const invoke = hookInvocation(hook, name, context, value);
    if (!invoke) {
      continue;
    }
    const startedAt = new Date();
    const startedAtMs = Date.now();
    try {
      await invokeWithTimeout(invoke, timeoutMs);
      await recordHookTrace(deps.hookTraceStore, context, hook.id, name as HookLifecycle, "completed", startedAt, startedAtMs);
    } catch (error) {
      await recordHookTrace(
        deps.hookTraceStore,
        context,
        hook.id,
        name as HookLifecycle,
        "failed",
        startedAt,
        startedAtMs,
        error
      );
      // Hooks are extension points and must fail open.
    }
  }
}

/** Merge static + registry hooks by id (registry wins on collision). */
export function mergedHooks(deps: InvokeHooksDeps): readonly HookStage[] {
  const hooksById = new Map<string, HookStage>();
  for (const hook of deps.hooks) {
    hooksById.set(hook.id, hook);
  }
  for (const hook of deps.hookRegistry?.list() ?? []) {
    hooksById.set(hook.id, hook);
  }
  return [...hooksById.values()];
}

/**
 * Resolves a hook stage + lifecycle name into a thunk. Returns `undefined`
 * when the hook didn't implement the requested lifecycle. Exported so the
 * runtime tests can assert dispatch behaviour without booting an agent.
 */
export function hookInvocation(
  hook: HookStage,
  name: keyof HookStage,
  context: AgentRunContext,
  value: unknown
): (() => Awaitable<void>) | undefined {
  const beforeStart = hook.beforeStart;
  const beforeTool = hook.beforeTool;
  const afterTool = hook.afterTool;
  const afterComplete = hook.afterComplete;
  const onError = hook.onError;

  if (name === "beforeStart" && beforeStart) {
    return () => beforeStart(context);
  }

  if (name === "beforeTool" && beforeTool) {
    return () => beforeTool(context, value as ModelToolCall);
  }

  if (name === "afterTool" && afterTool) {
    const toolValue = value as { readonly result: ToolExecutionResult; readonly toolCall: ModelToolCall };
    return () => afterTool(context, toolValue.toolCall, toolValue.result);
  }

  if (name === "afterComplete" && afterComplete) {
    return () => afterComplete(context, value as ModelResponse);
  }

  if (name === "onError" && onError) {
    return () => onError(context, value);
  }

  return undefined;
}

/**
 * Persists a hook-invocation trace. Fail-open: trace-store errors never
 * propagate.
 */
export async function recordHookTrace(
  hookTraceStore: HookTraceStore | undefined,
  context: AgentRunContext,
  hookId: string,
  lifecycle: HookLifecycle,
  status: "completed" | "failed",
  startedAt: Date,
  startedAtMs: number,
  error?: unknown
): Promise<void> {
  if (!hookTraceStore) {
    return;
  }
  try {
    await hookTraceStore.record({
      completedAt: new Date(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      ...(error ? { error: error instanceof Error ? error.message : "unknown hook failure" } : {}),
      hookId,
      lifecycle,
      ...(context.input.metadata ? { metadata: context.input.metadata } : {}),
      runId: context.runId,
      startedAt,
      status
    });
  } catch {
    // Hook trace recording must not block agent execution.
  }
}
