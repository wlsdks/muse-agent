/**
 * Idle-timeout wrapper for a model event stream, split out of model-loop.ts
 * so the pure async-gen wrapper can be read/tested independently of the
 * loop-orchestration file it's used from.
 */

import { ModelProviderError } from "@muse/model";
import { setTimeout as sleepWithTimer } from "node:timers/promises";

/**
 * Default idle cut for the streaming path (3 min). Overridable per-run via
 * `runner.streamIdleTimeoutMs`, which autoconfigure wires from
 * `MUSE_STREAM_IDLE_TIMEOUT_MS` — so an operator can shorten the bound (e.g. to
 * fail a black-holed local stream in 8s instead of 3 min) without a code change.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;

/**
 * Wrap a model event stream with an IDLE timeout: if the provider emits no next
 * event within `idleMs`, close the underlying stream and throw — so a hung
 * provider (a stalled local Ollama) fails the turn instead of blocking the agent
 * forever. `idleMs <= 0` disables (passes through). The timer resets on EACH event,
 * so a slow-but-progressing stream is never cut; only a true stall trips it. Pure
 * wrapper — exported for direct testing without a live model.
 */
export async function* withStreamIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  providerId: string
): AsyncGenerator<T> {
  if (!(idleMs > 0)) {
    yield* source;
    return;
  }
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const timerController = new AbortController();
      const idle = (async () => {
        await sleepWithTimer(idleMs, undefined, { signal: timerController.signal });
        throw new ModelProviderError(
          providerId,
          `model stream idle for >${idleMs.toString()}ms — provider stalled`,
          false
        );
      })();
      let step: IteratorResult<T>;
      try {
        step = await Promise.race([iterator.next(), idle]);
      } finally {
        timerController.abort();
      }
      if (step.done) return;
      yield step.value;
    }
  } finally {
    // Close the underlying stream/fetch on idle-abort OR normal completion —
    // FIRE-AND-FORGET: awaiting `.return()` on a HUNG stream would block until its
    // own stalled await resolves, re-introducing the very hang we're cutting.
    void iterator.return?.()?.catch(() => undefined);
  }
}
