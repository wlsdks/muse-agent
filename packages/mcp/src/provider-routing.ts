const PRIMARY_SENTINELS = new Set(["default", "primary"]);

/**
 * A local model with no live provider list often invents a sentinel like
 * "default"/"primary" to mean "my main one" when a tool asks for a providerId.
 * Treat those (and blank) as "use the primary provider" on CREATE paths so a
 * valid write doesn't fail on a hallucinated routing field — a concrete unknown
 * id still errors rather than silently writing to the wrong store.
 */
export function isPrimarySentinel(providerId: string): boolean {
  return PRIMARY_SENTINELS.has(providerId.trim().toLowerCase());
}
