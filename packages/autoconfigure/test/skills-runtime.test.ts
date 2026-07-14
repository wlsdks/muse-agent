import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { createSkillRuntime } from "../src/skills-runtime.js";
import type { MuseEnvironment } from "../src/index.js";

// Coverage for createSkillRuntime (untested) — wires the muse.skills.* tools to
// an ASYNC disk scan. The load-bearing subtlety is the lazy cache: the registry
// scan completes asynchronously while the surrounding assembly stays
// synchronous, so the skill tools must see an EMPTY list until the promise
// resolves (rather than throw or block), then surface the scanned skills.

const skillsRootWith = (skill?: { name: string; description: string }): { env: MuseEnvironment; userDir: string } => {
  const base = mkdtempSync(join(tmpdir(), "muse-skills-rt-"));
  const userDir = join(base, "skills");
  const authoredDir = join(base, "authored");
  mkdirSync(authoredDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  if (skill) {
    mkdirSync(join(userDir, skill.name), { recursive: true });
    writeFileSync(join(userDir, skill.name, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\nBody.`);
  }
  // Pin BOTH skills dirs to tmp so the real ~/.muse/skills is never scanned.
  return { env: { MUSE_AUTHORED_SKILLS_DIR: authoredDir, MUSE_SKILLS_DIR: userDir } as unknown as MuseEnvironment, userDir };
};

const flushMicrotasks = (): Promise<void> => sleep(0);

describe("createSkillRuntime", () => {
  it("exposes the three muse.skills.* tools when enabled (default)", () => {
    const { env } = skillsRootWith();
    const runtime = createSkillRuntime(env);
    expect(runtime.skillTools.map((t) => t.definition.name)).toEqual(["muse.skills.list", "muse.skills.read", "muse.skills.run"]);
  });

  it("LAZY cache: the list tool returns [] before the async scan resolves, then surfaces the scanned skill", async () => {
    const { env } = skillsRootWith({ description: "Greet the user warmly", name: "greet" });
    const runtime = createSkillRuntime(env);
    const listTool = runtime.skillTools.find((t) => t.definition.name === "muse.skills.list");

    expect(listTool?.execute({})).toEqual({ skills: [] }); // scan still pending → empty, not a throw/block

    const registry = await runtime.skillRegistryPromise;
    await flushMicrotasks(); // let the internal .then populate the cache
    expect(registry?.list().map((s) => s.name)).toEqual(["greet"]);
    expect(listTool?.execute({})).toEqual({ skills: [{ description: "Greet the user warmly", name: "greet" }] });
  });

  it("returns no tools and an undefined registry when MUSE_SKILLS_ENABLED=false", async () => {
    const { env } = skillsRootWith({ description: "x", name: "greet" });
    const runtime = createSkillRuntime({ ...env, MUSE_SKILLS_ENABLED: "false" } as MuseEnvironment);
    expect(runtime.skillTools).toEqual([]);
    expect(await runtime.skillRegistryPromise).toBeUndefined();
  });
});
