import { describe, expect, it } from "vitest";

import { handleSlashCommand, type SlashContext, type SlashDeps } from "./chat-repl-slash.js";
import type { ProgramIO } from "./program.js";

function harness() {
  const out: string[] = [];
  const io = {
    stdout: (m: string) => out.push(m),
    stderr: (m: string) => out.push(m)
  } as unknown as ProgramIO;
  const ctx = {
    active: true,
    currentPersona: undefined,
    currentModel: undefined,
    userId: "u",
    userMemory: undefined,
    trust: { trustedTools: [], blockedTools: [] },
    toolsDisabled: false,
    history: []
  } satisfies SlashContext;
  const deps = {
    memoryStore: undefined,
    autoExtract: undefined,
    assembly: {},
    readTrust: async () => ({ trustedTools: [], blockedTools: [] }),
    composeUserKey: () => "u"
  } satisfies SlashDeps;
  return { ctx, deps, io, text: () => out.join("") };
}

describe("handleSlashCommand unknown-command suggestion", () => {
  it("offers the closest valid slash command for a typo", async () => {
    const h = harness();
    await handleSlashCommand("histroy", "", h.ctx, h.deps, h.io);
    expect(h.text()).toContain("did you mean /history?");
    expect(h.text()).toContain("unknown command: /histroy");
  });

  it("suggests /remember for /rememer (deepens an existing surface to match the top-level CLI)", async () => {
    const h = harness();
    await handleSlashCommand("rememer", "", h.ctx, h.deps, h.io);
    expect(h.text()).toContain("did you mean /remember?");
  });

  it("makes NO guess when nothing is close — a random-looking suggestion is worse than none", async () => {
    const h = harness();
    await handleSlashCommand("zzzzzzzz", "", h.ctx, h.deps, h.io);
    expect(h.text()).toContain("(unknown command: /zzzzzzzz — try /help)\n");
    expect(h.text()).not.toContain("did you mean");
  });

  it("still dispatches a known command (no regression to the switch)", async () => {
    const h = harness();
    await handleSlashCommand("help", "", h.ctx, h.deps, h.io);
    expect(h.text()).toContain("/whoami");
    expect(h.text()).not.toContain("unknown command");
  });
});
