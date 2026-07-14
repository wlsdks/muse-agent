import { resolveDefaultUserId } from "@muse/autoconfigure";

/**
 * Resolves the default user id the CLI's user-scoped surfaces
 * (trust / approval / ask / chat / proactive) operate on.
 *
 * Five call sites previously inlined the identical chain
 * `options.user ?? MUSE_USER_ID ?? USER ?? "default"`. `??` only
 * falls back on nullish, so a shell that pre-clears `MUSE_USER_ID=`
 * (a common "zero out leaked env" pattern, the same shape goals
 * 478 / 481 fixed) left the chain returning `""` — every
 * user-scoped lookup then matched the empty bucket instead of the
 * real user's scope.
 *
 * Treats every link in the chain (override, MUSE_USER_ID, USER) as
 * "unset" when undefined OR empty/whitespace-only, and trims
 * surrounding whitespace before returning. Default fallback
 * `"default"`.
 */
export function resolveDefaultUserKey(opts: {
  readonly override?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
} = {}): string {
  const env = opts.env ?? process.env;
  const override = opts.override?.trim();
  if (override && override.length > 0) {
    return override;
  }
  // Env base (MUSE_USER_ID ?? USER ?? "default") is shared with the runtime
  // assembly so the bucket a fact is written under matches what recall reads.
  return resolveDefaultUserId(env);
}
