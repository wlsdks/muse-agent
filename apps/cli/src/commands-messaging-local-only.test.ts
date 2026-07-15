import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { registerMessagingCommands } from "./commands-messaging.js";

const KEYS = ["MUSE_LOCAL_ONLY", "MUSE_MESSAGING_CREDENTIALS_FILE", "MUSE_TELEGRAM_BOT_TOKEN"] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  process.exitCode = undefined;
});

describe("muse messaging --local — T2-B1", () => {
  it("omits a configured Telegram token from the local registry and never falls back to the API", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-messaging-local-only-"));
    const printed: unknown[] = [];
    try {
      process.env.MUSE_LOCAL_ONLY = "true";
      process.env.MUSE_MESSAGING_CREDENTIALS_FILE = join(root, "messaging.json");
      process.env.MUSE_TELEGRAM_BOT_TOKEN = "telegram-token";
      await writeFile(process.env.MUSE_MESSAGING_CREDENTIALS_FILE, JSON.stringify({ providers: { telegram: { token: "file-token" } } }));

      const program = new Command();
      program.exitOverride();
      registerMessagingCommands(program, { stderr: () => {}, stdout: () => {} }, {
        apiRequest: async () => { throw new Error("API must not be called by --local"); },
        writeOutput: (_io, value) => { printed.push(value); }
      });
      await program.parseAsync(["node", "muse", "messaging", "providers", "--local", "--json"], { from: "node" });

      expect(printed).toEqual([{ providers: [expect.objectContaining({ id: "log" })] }]);
      expect((printed[0] as { providers: { id: string }[] }).providers.map((provider) => provider.id)).toEqual(["log"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
