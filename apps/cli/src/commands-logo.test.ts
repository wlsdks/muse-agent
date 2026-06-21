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
    expect(out).toContain("\u001b[38;2;"); // 24-bit truecolor foreground escape
  });

  it("the art is a well-formed half-block grid (one cell glyph per column, reset per row)", () => {
    const lines = MUSE_MASCOT_ANSI.split("\n");
    expect(lines.length).toBe(MUSE_MASCOT_ROWS);
    for (const line of lines) {
      // each column emits exactly one cell glyph: ▀ (upper), ▄ (lower), or a space (transparent)
      const cells = line.match(/[▀▄ ]/gu) ?? [];
      expect(cells.length).toBe(MUSE_MASCOT_WIDTH);
      expect(line.endsWith("\u001b[0m")).toBe(true); // SGR reset closes every row
    }
  });

  it("uses 24-bit truecolor codes with valid 0-255 channels", () => {
    const triples = [...MUSE_MASCOT_ANSI.matchAll(/;2;(\d+);(\d+);(\d+)m/g)];
    expect(triples.length).toBeGreaterThan(0);
    for (const m of triples) {
      for (const ch of [m[1], m[2], m[3]]) {
        const v = Number(ch);
        expect(v >= 0 && v <= 255).toBe(true);
      }
    }
  });
});
