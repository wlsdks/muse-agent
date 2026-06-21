/**
 * The product's one-line identity, shown on the first screens a user
 * meets: the `muse --help` / non-TTY header (commander `.description`)
 * and the REPL splash tagline. Kept as a single source so the two
 * surfaces can never drift into two different self-descriptions.
 *
 * Wording is grounded in the product identity (CLAUDE.md): Muse is the
 * personal AI that learns YOU, and runs local-first / private by
 * default — not a generic "model-agnostic AI agent". No claim here
 * that the code doesn't hold (local-by-default is the enforced floor).
 */
export const MUSE_TAGLINE = "The personal AI that learns you — local-first, private by default";
