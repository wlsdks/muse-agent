import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSkillRuntime } from "../src/skills-runtime.js";
import type { MuseEnvironment } from "../src/index.js";
import { readSkillUsage } from "@muse/stores";

// Coverage for createSkillRuntime — wires the muse.skills.* tools to an ASYNC
// disk scan. The view used to read a `skillRegistryCache` variable that a
// `.then()` populated in the background, so a `list()`/`get()` racing ahead
// of that callback saw an empty cache and reported a populated skills dir as
// empty (list()) or "skill not found" for a skill that exists (read()) — a
// confident wrong answer, not a pending state. The view now awaits the SAME
// `skillRegistryPromise` on every call, so the FIRST call already sees the
// real scan result — there is no more "before the scan resolves" window to
// test.

const skillsRootWith = (skill?: { name: string; description: string; source?: "authored" | "user" }): { base: string; env: MuseEnvironment; userDir: string } => {
  const base = mkdtempSync(join(tmpdir(), "muse-skills-rt-"));
  const userDir = join(base, "skills");
  const authoredDir = join(base, "authored");
  mkdirSync(authoredDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  if (skill) {
    const root = skill.source === "authored" ? authoredDir : userDir;
    mkdirSync(join(root, skill.name), { recursive: true });
    writeFileSync(join(root, skill.name, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\nBody.`);
  }
  // Pin BOTH skills dirs to tmp so the real ~/.muse/skills is never scanned.
  return { base, env: { MUSE_AUTHORED_SKILLS_DIR: authoredDir, MUSE_SKILLS_DIR: userDir } as unknown as MuseEnvironment, userDir };
};

describe("createSkillRuntime", () => {
  it("exposes the three muse.skills.* tools when enabled (default)", () => {
    const { env } = skillsRootWith();
    const runtime = createSkillRuntime(env);
    expect(runtime.skillTools.map((t) => t.definition.name)).toEqual(["muse.skills.list", "muse.skills.read", "muse.skills.run"]);
  });

  it("the list tool sees the scanned skill on the very first call, no race window", async () => {
    const { env } = skillsRootWith({ description: "Greet the user warmly", name: "greet" });
    const runtime = createSkillRuntime(env);
    const listTool = runtime.skillTools.find((t) => t.definition.name === "muse.skills.list");

    // No `sleep`/flush needed — awaiting the tool call awaits the same
    // registry promise the runtime holds, so the disk scan is guaranteed
    // complete by the time this resolves.
    await expect(listTool?.execute({}, { runId: "r-1" })).resolves.toEqual({
      skills: [{ description: "Greet the user warmly", name: "greet" }]
    });
  });

  it("the read tool finds a skill on the very first call, no race window", async () => {
    const { env } = skillsRootWith({ description: "Greet the user warmly", name: "greet" });
    const runtime = createSkillRuntime(env);
    const readTool = runtime.skillTools.find((t) => t.definition.name === "muse.skills.read");

    const out = await readTool?.execute({ name: "greet" }, { runId: "r-1" }) as { error?: string; body?: string };
    expect(out.error).toBeUndefined();
    expect(out.body).toBe("Body.");
  });

  it("records an authored read but not a user-skill read", async () => {
    const authored = skillsRootWith({ description: "Greet the user warmly", name: "authored-greet", source: "authored" });
    const authoredEnv = { ...authored.env, MUSE_SKILL_REWARDS_FILE: join(authored.base, "skill-rewards.json") } as MuseEnvironment;
    const authoredRuntime = createSkillRuntime(authoredEnv);
    const authoredRead = authoredRuntime.skillTools.find((t) => t.definition.name === "muse.skills.read");
    await authoredRead?.execute({ name: "authored-greet" }, { runId: "r-1" });
    expect((await readSkillUsage(join(authored.base, "skill-usage.json")))["authored-greet"]?.viewCount).toBe(1);

    const user = skillsRootWith({ description: "Greet the user warmly", name: "user-greet", source: "user" });
    const userEnv = { ...user.env, MUSE_SKILL_REWARDS_FILE: join(user.base, "skill-rewards.json") } as MuseEnvironment;
    const userRuntime = createSkillRuntime(userEnv);
    const userRead = userRuntime.skillTools.find((t) => t.definition.name === "muse.skills.read");
    await userRead?.execute({ name: "user-greet" }, { runId: "r-1" });
    expect(await readSkillUsage(join(user.base, "skill-usage.json"))).toEqual({});
  });

  it("returns no tools and an undefined registry when MUSE_SKILLS_ENABLED=false", async () => {
    const { env } = skillsRootWith({ description: "x", name: "greet" });
    const runtime = createSkillRuntime({ ...env, MUSE_SKILLS_ENABLED: "false" } as MuseEnvironment);
    expect(runtime.skillTools).toEqual([]);
    expect(await runtime.skillRegistryPromise).toBeUndefined();
  });
});
