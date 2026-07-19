import type { ConnectionState } from "../components/connection-context.js";

/** True only on the genuine offline -> online edge (previous settled `false`,
 * current settled `true`) — never on the very first resolution (`undefined`
 * -> `true`), so a fresh page load doesn't invalidate every query it just
 * fetched. */
export function shouldInvalidateOnReconnect(previous: ConnectionState, current: ConnectionState): boolean {
  return previous === false && current === true;
}
