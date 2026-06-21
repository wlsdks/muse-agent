import { describe, expect, it } from "vitest";

import { MUSE_RUNTIME_SPEC, MUSE_RUNTIME_SPEC_TEXT, formatSpec, trySpecFastPath } from "./muse-spec.js";

describe("formatSpec", () => {
  it("renders the human stack line by default", () => {
    expect(formatSpec(false)).toBe(
      "Muse stack: TypeScript, Node.js, Fastify, PostgreSQL, Kysely, Ink, Rust runner\n"
    );
    expect(formatSpec()).toBe(`${MUSE_RUNTIME_SPEC_TEXT}\n`);
  });

  it("renders pretty JSON of the canonical spec when json=true", () => {
    expect(formatSpec(true)).toBe(`${JSON.stringify(MUSE_RUNTIME_SPEC, null, 2)}\n`);
    expect(JSON.parse(formatSpec(true))).toMatchObject({
      agentCore: "model-agnostic",
      runner: "rust",
      server: "fastify"
    });
  });
});

describe("trySpecFastPath", () => {
  const capture = () => {
    const out: string[] = [];
    return { out, write: (text: string) => out.push(text) };
  };

  it("handles `muse spec` and writes the human line", () => {
    const { out, write } = capture();
    expect(trySpecFastPath(["node", "muse", "spec"], write)).toBe(true);
    expect(out.join("")).toBe(formatSpec(false));
  });

  it("handles `muse spec --json` and writes pretty JSON", () => {
    const { out, write } = capture();
    expect(trySpecFastPath(["node", "muse", "spec", "--json"], write)).toBe(true);
    expect(out.join("")).toBe(formatSpec(true));
  });

  it("declines `muse spec --help` so commander renders help", () => {
    const { out, write } = capture();
    expect(trySpecFastPath(["node", "muse", "spec", "--help"], write)).toBe(false);
    expect(out).toHaveLength(0);
  });

  it("declines other commands and the bare invocation", () => {
    const { out, write } = capture();
    expect(trySpecFastPath(["node", "muse", "status"], write)).toBe(false);
    expect(trySpecFastPath(["node", "muse", "specs", "list"], write)).toBe(false);
    expect(trySpecFastPath(["node", "muse"], write)).toBe(false);
    expect(out).toHaveLength(0);
  });
});
