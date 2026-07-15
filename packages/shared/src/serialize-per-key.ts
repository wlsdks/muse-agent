/**
 * Serialize async operations per key so callers touching the same resource are
 * strictly sequenced, while different keys run independently.
 *
 * The returned promise is always the operation result, including rejections from
 * the scheduled operation. Rejections from prior queued work are absorbed so one
 * failing operation does not block the queue for the same key.
 */
import { withBestEffort } from "./best-effort.js";

export function serializePerKey<T>(inFlight: Map<string, Promise<unknown>>, key: string, operation: () => Promise<T>): Promise<T> {
  const prior = inFlight.get(key) ?? Promise.resolve();
  const next = (async (): Promise<T> => {
    await withBestEffort(prior, undefined);
    return operation();
  })();

  let serialized: Promise<unknown>;
  serialized = next.finally(() => {
    if (inFlight.get(key) === serialized) {
      inFlight.delete(key);
    }
  });

  inFlight.set(key, serialized);
  return next;
}
