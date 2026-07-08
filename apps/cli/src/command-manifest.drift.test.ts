import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { COMMAND_LOADERS, LOADER_BY_NAME } from "./command-loaders.js";
import { COMMAND_STUBS } from "./command-manifest.js";
import { createProgram, type ProgramIO } from "./program.js";

/**
 * The lazy-loading refactor renders `muse --help`, shell completion, and
 * did-you-mean off a GENERATED stub manifest (name + description + help term +
 * subcommand names) so those surfaces never import the ~100 command handlers.
 * If a command's real description / options / arguments / subcommands change
 * but the manifest isn't regenerated, help/completion silently drift. These
 * tests build the REAL command tree (by invoking every lazy loader) and pin the
 * manifest to it — a drift fails here, pointing you at `apps/cli/__gen.mjs`.
 */

const stubIo = { stdout: () => undefined, stderr: () => undefined } as unknown as ProgramIO;
// Registrars destructure the helper subset they need; a noop-returning Proxy
// satisfies every shape at register time (actions are never invoked here).
const stubDeps = new Proxy({}, { get: () => () => undefined });

function argsTerm(command: Command): string {
  const args = (command as unknown as { registeredArguments?: ReadonlyArray<{ name(): string; variadic: boolean; required: boolean }> })
    .registeredArguments ?? [];
  return args
    .map((arg) => {
      const named = arg.name() + (arg.variadic ? "..." : "");
      return arg.required ? `<${named}>` : `[${named}]`;
    })
    .join(" ");
}

interface RealMeta {
  readonly description: string;
  readonly argsTerm: string;
  readonly hasOptions: boolean;
  readonly subcommands: readonly string[];
}

async function buildRealLazyTree(): Promise<Map<string, RealMeta>> {
  const real = new Command();
  for (const loader of COMMAND_LOADERS) {
    await loader.load(real, stubIo, stubDeps as never);
  }
  const byName = new Map<string, RealMeta>();
  for (const command of real.commands) {
    const name = command.name();
    if (!name || name === "*") continue;
    byName.set(name, {
      description: command.description(),
      argsTerm: argsTerm(command),
      hasOptions: (command.options ?? []).length > 0,
      subcommands: command.commands.map((sub) => sub.name()).filter(Boolean).sort()
    });
  }
  return byName;
}

describe("command manifest drift guard", () => {
  it("every lazy loader owns a name that resolves to itself", () => {
    for (const loader of COMMAND_LOADERS) {
      for (const name of loader.names) {
        expect(LOADER_BY_NAME.get(name)).toBe(loader);
      }
    }
  });

  it("the stub manifest matches the real command tree exactly (names + metadata)", async () => {
    const real = await buildRealLazyTree();
    const realNames = [...real.keys()].sort();
    const stubNames = COMMAND_STUBS.map((s) => s.name).sort();
    expect(stubNames).toEqual(realNames);

    for (const stub of COMMAND_STUBS) {
      const meta = real.get(stub.name);
      expect(meta, `no real command produced for stub '${stub.name}'`).toBeDefined();
      expect({
        description: stub.description,
        argsTerm: stub.argsTerm,
        hasOptions: stub.hasOptions,
        subcommands: [...stub.subcommands].sort()
      }).toEqual({
        description: meta!.description,
        argsTerm: meta!.argsTerm,
        hasOptions: meta!.hasOptions,
        subcommands: [...meta!.subcommands].sort()
      });
    }
  });

  it("every lazy command name has a loader", () => {
    for (const stub of COMMAND_STUBS) {
      expect(LOADER_BY_NAME.has(stub.name), `no loader for '${stub.name}'`).toBe(true);
    }
  });

  it("createProgram registers every stub plus the eager inline commands (no command lost)", () => {
    const eager = ["config-path", "spec", "tui", "chat", "runtime", "loopback", "snapshot", "context", "completion"];
    const program = createProgram(stubIo);
    const registered = program.commands.map((c) => c.name()).filter((n): n is string => Boolean(n) && n !== "*");
    const expected = [...eager, ...COMMAND_STUBS.map((s) => s.name)].sort();
    expect([...new Set(registered)].sort()).toEqual(expected);
  });
});
