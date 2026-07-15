/**
 * Levenshtein-based closest-match for unknown CLI
 * subcommand names. Lets `muse statu` answer with
 * "Did you mean 'status'?" instead of the commander default
 * "too many arguments" error that hid the typo.
 *
 * The algorithm itself lives in `@muse/shared` (`closestCommandName`)
 * so other surfaces — e.g. the `/model <name>` channel switch
 * (packages/autoconfigure's model-registry) — reuse the exact same
 * matching semantics instead of drifting; this module re-exports it
 * for the ~dozen existing CLI call sites and this file's own tests.
 */

export { closestCommandName, levenshteinDistance } from "@muse/shared";
