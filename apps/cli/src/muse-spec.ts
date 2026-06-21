/**
 * The fixed runtime-stack descriptor + a pre-framework fast path for
 * `muse spec`.
 *
 * Like `muse-version.ts`, the trivial `muse spec` probe otherwise paid the
 * full ~0.5s import tax because `index.ts` reaches it only after pulling in
 * the entire command graph (~100+ modules). This LEAF module carries no heavy
 * imports, so handling `spec` here and only THEN importing the framework keeps
 * it near-instant. `program.ts` renders from the SAME constants via
 * `formatSpec`, so the fast path and the framework command can never disagree.
 */
export const MUSE_RUNTIME_SPEC = {
  agentCore: "model-agnostic",
  cli: "typescript + ink",
  database: "postgresql + kysely",
  runner: "rust",
  server: "fastify"
} as const;

export const MUSE_RUNTIME_SPEC_TEXT =
  "Muse stack: TypeScript, Node.js, Fastify, PostgreSQL, Kysely, Ink, Rust runner";

export function formatSpec(json?: boolean): string {
  return json ? `${JSON.stringify(MUSE_RUNTIME_SPEC, null, 2)}\n` : `${MUSE_RUNTIME_SPEC_TEXT}\n`;
}

/**
 * Print the stack and report handled=true ONLY for the exact `muse spec` /
 * `muse spec --json` invocation (nothing else on the line). Any other argv —
 * including `muse spec --help` — returns false so the full commander program
 * runs unchanged; the fast path never alters behaviour, it only skips the
 * import graph for the one trivial case.
 */
export function trySpecFastPath(argv: readonly string[], write: (text: string) => void): boolean {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === "spec") {
    write(formatSpec(false));
    return true;
  }
  if (args.length === 2 && args[0] === "spec" && args[1] === "--json") {
    write(formatSpec(true));
    return true;
  }
  return false;
}
