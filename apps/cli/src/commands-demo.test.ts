import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import {
  buildDemoEnv,
  DEMO_QUESTIONS,
  registerDemoCommand,
  resolveDemoCorpusDir,
  type DemoAskRunner
} from "./commands-demo.js";
import type { ProgramIO } from "./program.js";

function fakeIo(): { io: ProgramIO; out: string[] } {
  const out: string[] = [];
  return {
    out,
    io: { stdout: (m) => out.push(m), stderr: () => {} }
  };
}

describe("resolveDemoCorpusDir", () => {
  it("resolves a real directory that contains the WireGuard sample note", () => {
    const dir = resolveDemoCorpusDir();
    expect(isAbsolute(dir)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(`${dir}/2026-03-03-vpn-wireguard.md`)).toBe(true);
  });

  it("falls back to the repo fixtures seed when the packaged copy is absent", () => {
    const fromBogus = resolveDemoCorpusDir("/nonexistent/module/dir");
    expect(fromBogus).toMatch(/fixtures[\\/]mock-corpus[\\/]notes$/);
  });
});

describe("DEMO_QUESTIONS", () => {
  it("shows both halves of the edge: ≥2 answerable (citing different notes) then ≥1 must-refuse", () => {
    const answerable = DEMO_QUESTIONS.filter((q) => q.kind === "answerable");
    const refuse = DEMO_QUESTIONS.filter((q) => q.kind === "refuse");
    expect(answerable.length).toBeGreaterThanOrEqual(2);
    expect(refuse.length).toBeGreaterThanOrEqual(1);
    // answerable-first so the user sees a cited win before the refusal
    expect(DEMO_QUESTIONS[0]?.kind).toBe("answerable");
    // the answerable questions exercise DIFFERENT notes (not one lucky hit)
    expect(new Set(answerable.map((q) => q.expect)).size).toBe(answerable.length);
  });
});

describe("buildDemoEnv", () => {
  it("redirects HOME so every ~/.muse default isolates, points notes at the corpus, forces local-only", () => {
    const env = buildDemoEnv({ PATH: "/usr/bin", HOME: "/Users/real" }, { corpusDir: "/sample/corpus", home: "/tmp/demo-home" });
    // HOME override is the single lever that isolates tasks/reminders/episodes too
    expect(env.HOME).toBe("/tmp/demo-home");
    expect(env.USERPROFILE).toBe("/tmp/demo-home");
    expect(env.HOME).not.toBe("/Users/real");
    expect(env.MUSE_NOTES_DIR).toBe("/sample/corpus");
    expect(env.MUSE_NOTES_INDEX_FILE?.startsWith("/tmp/demo-home")).toBe(true);
    expect(env.MUSE_LOCAL_ONLY).toBe("true");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("muse demo command", () => {
  it("prints the local-only banner and asks both questions answerable-first against an isolated env", async () => {
    const { io, out } = fakeIo();
    const calls: { question: string; env: NodeJS.ProcessEnv }[] = [];
    const askRunner: DemoAskRunner = (question, env) => {
      calls.push({ question, env });
    };
    const program = new Command();
    program.exitOverride();
    registerDemoCommand(program, io, { askRunner, corpusDir: "/sample/corpus" });

    await program.parseAsync(["node", "muse", "demo"]);

    const banner = out.join("");
    expect(banner).toMatch(/nothing leaves/i);
    expect(calls.map((c) => c.question)).toEqual(DEMO_QUESTIONS.map((q) => q.question));
    for (const call of calls) {
      expect(call.env.MUSE_NOTES_DIR).toBe("/sample/corpus");
      expect(call.env.MUSE_LOCAL_ONLY).toBe("true");
      expect(call.env.HOME?.startsWith(tmpdir())).toBe(true);
      expect(call.env.MUSE_NOTES_INDEX_FILE?.startsWith(tmpdir())).toBe(true);
    }
  });

  it("awaits an async ask runner before printing the closing tip", async () => {
    const { io, out } = fakeIo();
    const order: string[] = [];
    const askRunner: DemoAskRunner = async () => {
      await Promise.resolve();
      order.push("asked");
    };
    const program = new Command();
    program.exitOverride();
    registerDemoCommand(program, io, { askRunner, corpusDir: "/c" });
    await program.parseAsync(["node", "muse", "demo"]);
    order.push("done");
    expect(order.filter((s) => s === "asked")).toHaveLength(DEMO_QUESTIONS.length);
    expect(out.join("")).toMatch(/muse ingest/);
  });
});
