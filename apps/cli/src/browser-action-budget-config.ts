/**
 * The per-task browser-action budget. `browser_click` / `browser_type` /
 * `browser_fill_form` used to run unbounded — an 8B model stuck in a retry
 * loop could click/type indefinitely on a live page. `MUSE_BROWSER_MAX_ACTIONS`
 * overrides the default of 30; a cap of 0 would forbid ALL browser actions
 * (not the intent of "lower the limit"), so — like `resolveJobsMaxConcurrent`
 * — 0/negative/non-integer/absent falls back to the default rather than
 * floors at 1.
 */
export function resolveBrowserMaxActions(env: Record<string, string | undefined>): number {
  const raw = env.MUSE_BROWSER_MAX_ACTIONS?.trim();
  const parsed = Number(raw);
  if (raw && Number.isInteger(parsed) && parsed > 0) return parsed;
  return 30;
}
