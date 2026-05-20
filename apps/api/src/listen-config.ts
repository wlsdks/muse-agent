/**
 * Side-effect-free resolvers for the Fastify `server.listen({ host,
 * port })` call in `index.ts`. Lifted out so the bind-config
 * contract has direct unit tests — `index.ts` itself is the
 * entry-point and runs `server.listen()` at import time, so it
 * can't be imported from a test without starting the server.
 */

/**
 * `PORT` env → integer port in (0, 65535].
 *
 * A pre-cleared `PORT=` (the "zero out leaked env" launcher pattern)
 * or a typo like `PORT=3030x` would otherwise fall to:
 *   - `"" ?? 3030` → `""` → `Number("")` → `0`, binding an ephemeral
 *     port the operator can't reach;
 *   - `Number("3030x")` → `NaN`, which Fastify rejects with an
 *     opaque error.
 * Strict parse + fallback is the right boundary.
 */
export function resolveListenPort(raw: string | undefined, fallback = 3030): number {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

/**
 * `HOST` env → bind address.
 *
 * A pre-cleared `HOST=` would otherwise produce the empty string,
 * which Fastify silently treats as `::` (all interfaces) on dual-
 * stack platforms — surprising for an operator who set `HOST=`
 * expecting "no override, use the default loopback". Treat empty
 * / whitespace-only as unset.
 */
export function resolveListenHost(raw: string | undefined, fallback = "127.0.0.1"): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}
