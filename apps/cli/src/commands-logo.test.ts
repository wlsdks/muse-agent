import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerLogoCommand } from "./commands-logo.js";
import { MUSE_BIRD_ANSI, MUSE_BIRD_ROWS } from "./muse-mascot.js";

async function run(env: Record<string, string | undefined> = {}): Promise<string> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    const stdout: string[] = [];
    const io = { stderr: () => {}, stdout: (m: string) => stdout.push(m) };
    const program = new Command();
    program.exitOverride();
    registerLogoCommand(program, io);
    await program.parseAsync(["node", "muse", "logo"]);
    return stdout.join("");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

describe("muse logo — the bluebird mascot banner", () => {
  it("prints the bird art (half-block glyphs + truecolor) and the wordmark", async () => {
    const out = await run({ NO_COLOR: undefined, FORCE_COLOR: "1" });
    expect(out).toContain(MUSE_BIRD_ANSI);
    expect(/[▀▄]/u.test(out)).toBe(true); // half-block cell glyph — confirms it's the art
    expect(out).toContain("[38;2;"); // 24-bit truecolor foreground escape
    expect(out).toContain("██"); // the MUSE wordmark block art
    expect(out.endsWith("\n")).toBe(true);
  });

  it("the bird is a compact 6-line half-block grid (11 rows packed 2-per-line)", () => {
    const lines = MUSE_BIRD_ANSI.split("\n");
    expect(lines.length).toBe(MUSE_BIRD_ROWS);
    expect(MUSE_BIRD_ROWS).toBe(6);
  });

  it("uses 24-bit truecolor codes with valid 0-255 channels", () => {
    const triples = [...MUSE_BIRD_ANSI.matchAll(/;2;(\d+);(\d+);(\d+)m/g)];
    expect(triples.length).toBeGreaterThan(0);
    for (const m of triples) {
      for (const ch of [m[1], m[2], m[3]]) {
        const v = Number(ch);
        expect(v >= 0 && v <= 255).toBe(true);
      }
    }
  });

  it("falls back to the plain wordmark (no escapes) under NO_COLOR", async () => {
    const out = await run({ NO_COLOR: "1", FORCE_COLOR: undefined });
    expect(out).toContain("██"); // wordmark
    expect(out).not.toContain("\x1b["); // no ANSI escapes when colour is off
  });
});
