import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createProgram, type ProgramIO } from "./program.js";
import { MUSE_CLI_VERSION, tryVersionFastPath } from "./muse-version.js";

describe("tryVersionFastPath", () => {
  const capture = () => {
    const out: string[] = [];
    return { out, write: (s: string) => { out.push(s); } };
  };

  it("handles `muse --version` by printing the version and reporting handled", () => {
    const { out, write } = capture();
    expect(tryVersionFastPath(["node", "muse", "--version"], write)).toBe(true);
    expect(out.join("")).toBe(`${MUSE_CLI_VERSION}\n`);
  });

  it("handles the `-V` short flag the same way", () => {
    const { out, write } = capture();
    expect(tryVersionFastPath(["node", "muse", "-V"], write)).toBe(true);
    expect(out.join("")).toBe(`${MUSE_CLI_VERSION}\n`);
  });

  it("does NOT handle a real command — returns false and writes nothing", () => {
    const { out, write } = capture();
    expect(tryVersionFastPath(["node", "muse", "status"], write)).toBe(false);
    expect(out.join("")).toBe("");
  });

  it("does NOT handle a bare invocation or --version with extra args (let commander decide)", () => {
    const { out, write } = capture();
    expect(tryVersionFastPath(["node", "muse"], write)).toBe(false);
    expect(tryVersionFastPath(["node", "muse", "--version", "extra"], write)).toBe(false);
    expect(out.join("")).toBe("");
  });
});

describe("MUSE_CLI_VERSION", () => {
  it("is the single source the commander program reports (fast path and --version agree)", () => {
    const io: ProgramIO = { stderr: () => undefined, stdout: () => undefined };
    const program = createProgram(io);
    expect(program.version()).toBe(MUSE_CLI_VERSION);
  });

  it("matches the product version in the root package.json (drift guard)", () => {
    const rootPkgUrl = new URL("../../../package.json", import.meta.url);
    const rootVersion = (JSON.parse(readFileSync(fileURLToPath(rootPkgUrl), "utf8")) as { version: string }).version;
    expect(MUSE_CLI_VERSION).toBe(rootVersion);
  });

  it("is no longer the stale placeholder 0.0.0", () => {
    expect(MUSE_CLI_VERSION).not.toBe("0.0.0");
  });
});
