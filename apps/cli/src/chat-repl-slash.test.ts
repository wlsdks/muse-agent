import { describe, expect, it } from "vitest";

import { handleSlashCommand, type SlashContext, type SlashDeps } from "./chat-repl-slash.js";
import type { ProgramIO } from "./program.js";

function harness() {
  const out: string[] = [];
  const io = {
    stdout: (m: string) => out.push(m),
    stderr: (m: string) => out.push(m)
  } as unknown as ProgramIO;
  const ctx: SlashContext = {
    active: true,
    currentPersona: undefined,
    currentModel: undefined,
    userId: "u",
    userMemory: undefined,
    trust: { trustedTools: [], blockedTools: [] },
    toolsDisabled: false,
    history: []
  };
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

describe("handleSlashCommand /tools — case-insensitive enum matching", () => {
  it("/tools ON flips the toggle (pre-fix the case-sensitive comparison silently fell through to the usage echo)", async () => {
    const h = harness();
    h.ctx.toolsDisabled = true;
    await handleSlashCommand("tools", "ON", h.ctx, h.deps, h.io);
    expect(h.ctx.toolsDisabled, "tools=ON must enable, not fall through").toBe(false);
    expect(h.text()).toContain("(tools on)");
    expect(h.text()).not.toContain("currently");
  });

  it("/tools Off flips the toggle (mixed-case)", async () => {
    const h = harness();
    h.ctx.toolsDisabled = false;
    await handleSlashCommand("tools", "Off", h.ctx, h.deps, h.io);
    expect(h.ctx.toolsDisabled).toBe(true);
    expect(h.text()).toContain("(tools off");
  });

  it("/tools '  on  ' trims surrounding whitespace before matching", async () => {
    const h = harness();
    h.ctx.toolsDisabled = true;
    await handleSlashCommand("tools", "  on  ", h.ctx, h.deps, h.io);
    expect(h.ctx.toolsDisabled).toBe(false);
  });

  it("/tools wat still falls through to the usage echo (no false positive for unrelated input)", async () => {
    const h = harness();
    h.ctx.toolsDisabled = false;
    await handleSlashCommand("tools", "wat", h.ctx, h.deps, h.io);
    expect(h.ctx.toolsDisabled, "unrelated input must NOT silently flip the state").toBe(false);
    expect(h.text()).toContain("currently on");
    expect(h.text()).toContain("usage: /tools on|off");
  });
});

describe("handleSlashCommand /persona — sentinel matching is case-insensitive", () => {
  it("/persona NONE clears the active persona (pre-fix case-sensitive sentinel set it to literal 'NONE')", async () => {
    const h = harness();
    h.ctx.currentPersona = "work";
    await handleSlashCommand("persona", "NONE", h.ctx, h.deps, h.io);
    expect(h.ctx.currentPersona, "uppercase NONE must clear, not get stored as a persona name").toBeUndefined();
    expect(h.text()).toContain("persona → (base)");
  });

  it("/persona Default also clears (mixed-case sentinel)", async () => {
    const h = harness();
    h.ctx.currentPersona = "work";
    await handleSlashCommand("persona", "Default", h.ctx, h.deps, h.io);
    expect(h.ctx.currentPersona).toBeUndefined();
  });

  it("/persona work passes through unchanged (non-sentinel input preserves the original casing)", async () => {
    const h = harness();
    h.ctx.currentPersona = undefined;
    await handleSlashCommand("persona", "work", h.ctx, h.deps, h.io);
    expect(h.ctx.currentPersona).toBe("work");
  });
});
