import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildAgentScaffold, isSafeAgentName, loadAgents, resolveAgentsDir } from "./commands-agents.js";

describe("resolveAgentsDir", () => {
  it("honours MUSE_AGENTS_DIR, else defaults under ~/.muse/agents", () => {
    expect(resolveAgentsDir({ MUSE_AGENTS_DIR: "/tmp/a" } as NodeJS.ProcessEnv)).toBe("/tmp/a");
    expect(resolveAgentsDir({} as NodeJS.ProcessEnv).replaceAll("\\", "/").endsWith("/.muse/agents")).toBe(true);
  });
});

describe("isSafeAgentName", () => {
  it("rejects traversal / odd chars", () => {
    expect(isSafeAgentName("researcher")).toBe(true);
    expect(isSafeAgentName("../x")).toBe(false);
  });
});

describe("buildAgentScaffold", () => {
  it("writes valid frontmatter + a system-prompt body", () => {
    const md = buildAgentScaffold("coder", "writes code");
    expect(md).toContain("name: coder");
    expect(md).toContain("description: writes code");
    expect(md).toContain("You are coder.");
  });
});

describe("loadAgents", () => {
  it("loads AGENT.md folders and ignores non-agent dirs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-agents-"));
    await mkdir(join(dir, "researcher"), { recursive: true });
    await writeFile(join(dir, "researcher", "AGENT.md"), buildAgentScaffold("researcher", "investigates"), "utf8");
    await mkdir(join(dir, "empty"), { recursive: true }); // no AGENT.md → skipped

    const defs = await loadAgents(dir);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("researcher");
    expect(defs[0]?.description).toBe("investigates");
    expect(defs[0]?.prompt).toContain("You are researcher.");
  });

  it("returns empty for a missing directory", async () => {
    expect(await loadAgents("/no/such/dir/muse-agents")).toEqual([]);
  });
});
