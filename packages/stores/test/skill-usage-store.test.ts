import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  readSkillUsage,
  recordSkillUse,
  recordSkillView,
  SKILL_USAGE_SCHEMA_VERSION
} from "../src/skill-usage-store.js";

const roots: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `muse-skill-usage-${randomUUID()}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("skill usage sidecar", () => {
  it("records uses and views in a versioned durable map", async () => {
    const file = join(await freshRoot(), "skill-usage.json");
    const at = new Date("2026-08-09T00:00:00.000Z");

    await recordSkillUse(file, "release", at);
    const next = await recordSkillUse(file, "release", new Date("2026-08-09T00:01:00.000Z"));
    await recordSkillView(file, "release", at);

    expect(next).toEqual({ lastActivity: "2026-08-09T00:01:00.000Z", useCount: 2, viewCount: 0 });
    expect(await readSkillUsage(file)).toEqual({
      release: { lastActivity: "2026-08-09T00:00:00.000Z", useCount: 2, viewCount: 1 }
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: SKILL_USAGE_SCHEMA_VERSION });
  });

  it("sanitizes missing, corrupt, unknown, negative, and non-finite rows", async () => {
    const root = await freshRoot();
    const missing = join(root, "missing.json");
    expect(await readSkillUsage(missing)).toEqual({});

    const corrupt = join(root, "corrupt.json");
    await writeFile(corrupt, "not-json", "utf8");
    expect(await readSkillUsage(corrupt)).toEqual({});

    const invalid = join(root, "invalid.json");
    await writeFile(invalid, JSON.stringify({
      skills: {
        bad: { lastActivity: "nope", useCount: -1, viewCount: Number.NaN },
        good: { lastActivity: "2026-08-09T00:00:00.000Z", useCount: 2.8, viewCount: 3 }
      },
      version: SKILL_USAGE_SCHEMA_VERSION
    }), "utf8");
    expect(await readSkillUsage(invalid)).toEqual({
      bad: { lastActivity: null, useCount: 0, viewCount: 0 },
      good: { lastActivity: "2026-08-09T00:00:00.000Z", useCount: 2, viewCount: 3 }
    });
  });

  it("fails soft for invalid names, invalid clocks, and write failures", async () => {
    const file = join(await freshRoot(), "skill-usage.json");
    expect(await recordSkillUse(file, "", new Date())).toBeUndefined();
    expect(await recordSkillUse(file, "release", new Date(Number.NaN))).toBeUndefined();
    const blockedRoot = await freshRoot();
    const blockedParent = join(blockedRoot, "not-a-directory");
    await writeFile(blockedParent, "file", "utf8");
    const blocked = join(blockedParent, "skill-usage.json");
    expect(await recordSkillView(blocked, "release")).toBeUndefined();
  });

  it("serializes two explicit use events without hidden deduplication", async () => {
    const file = join(await freshRoot(), "skill-usage.json");
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
    await recordSkillUse(file, "release", new Date("2026-08-09T00:00:00.000Z"), { beforeWrite: pause });
    await recordSkillUse(file, "release", new Date("2026-08-09T00:01:00.000Z"), { beforeWrite: pause });
    expect((await readSkillUsage(file)).release?.useCount).toBe(2);
  });

  it("keeps increments from separately spawned OS processes", async () => {
    const root = await freshRoot();
    const file = join(root, "skill-usage.json");
    const childScript = join(root, "record-usage.mjs");
    const source = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../src/skill-usage-store.ts")).href;
    await writeFile(childScript, `
      import { recordSkillUse } from ${JSON.stringify(source)};
      const [file, at] = process.argv.slice(2);
      await recordSkillUse(file, "release", new Date(at), {
        beforeWrite: () => new Promise((resolve) => setTimeout(resolve, 100))
      });
    `, "utf8");
    const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
    const run = (at: string): Promise<void> => new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [tsxCli, childScript, file, at], { stderr: "pipe", stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolveRun() : reject(new Error(stderr || `child exited ${code ?? "unknown"}`)));
    });

    await Promise.all([
      run("2026-08-09T00:00:00.000Z"),
      run("2026-08-09T00:01:00.000Z")
    ]);
    expect((await readSkillUsage(file)).release?.useCount).toBe(2);
  });
});
