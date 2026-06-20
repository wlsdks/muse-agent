import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerLogoCommand } from "./commands-logo.js";
import { MUSE_MASCOT_ANSI, MUSE_MASCOT_ROWS, MUSE_MASCOT_WIDTH } from "./muse-mascot-ansi.js";

async function run(): Promise<string> {
  const stdout: string[] = [];
  const io = { stderr: () => {}, stdout: (m: string) => stdout.push(m) };
  const program = new Command();
  program.exitOverride();
  registerLogoCommand(program, io);
  await program.parseAsync(["node", "muse", "logo"]);
  return stdout.join("");
}

describe("muse logo — the mascot banner", () => {
  it("prints the goddess mascot art", async () => {
    const out = await run();
    expect(out).toContain(MUSE_MASCOT_ANSI);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("▀"); // upper half-block ▀ — confirms it's the art
    expect(out).toContain("\u001b[38;5;"); // 256-color foreground escape
  });

  it("the art is a well-formed half-block grid (one ▀ per cell, reset per row)", () => {
    const lines = MUSE_MASCOT_ANSI.split("\n");
    expect(lines.length).toBe(MUSE_MASCOT_ROWS);
    for (const line of lines) {
      // one ▀ per column → exactly WIDTH blocks per row
      expect(line.split("▀").length - 1).toBe(MUSE_MASCOT_WIDTH);
      expect(line.endsWith("\u001b[0m")).toBe(true); // SGR reset closes every row
    }
  });

  it("uses only valid xterm-256 grayscale codes (16 / 231 / 232-255)", () => {
    const codes = [...MUSE_MASCOT_ANSI.matchAll(/5;(\d+)m/g)].map((m) => Number(m[1]));
    expect(codes.length).toBeGreaterThan(0);
    for (const c of codes) {
      const ok = c === 16 || c === 231 || (c >= 232 && c <= 255);
      expect(ok).toBe(true);
    }
  });
});
