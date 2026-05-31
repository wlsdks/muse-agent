import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { countNotes, readMcpEntryCount, readTaskCount, statBytes } from "../src/setup-status.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-setup-")); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

// The counters behind `muse doctor` / setup-status. Each degrades on a missing /
// malformed source — but to DIFFERENT defaults (undefined vs 0), which the report
// renders distinctly ("unknown" vs "0"), so the default per fn is part of the contract.
describe("countNotes", () => {
  it("counts .md/.markdown/.txt files + each subdir as one, skipping dotfiles and other extensions", async () => {
    await writeFile(join(dir, "a.md"), "x");
    await writeFile(join(dir, "b.markdown"), "x");
    await writeFile(join(dir, "c.txt"), "x");
    await writeFile(join(dir, "ignore.json"), "x"); // wrong extension
    await writeFile(join(dir, ".hidden.md"), "x"); // dotfile
    await mkdir(join(dir, "sub"));
    expect(await countNotes(dir)).toBe(4); // 3 docs + 1 subdir
  });

  it("returns undefined for a missing directory", async () => {
    expect(await countNotes(join(dir, "nope"))).toBeUndefined();
  });
});

describe("statBytes", () => {
  it("returns the file size, undefined when the file is missing", async () => {
    await writeFile(join(dir, "f.bin"), "hello");
    expect(await statBytes(join(dir, "f.bin"))).toBe(5);
    expect(await statBytes(join(dir, "absent"))).toBeUndefined();
  });
});

describe("readTaskCount", () => {
  it("counts the tasks array, 0 for a wrong shape, undefined when missing/unreadable", async () => {
    await writeFile(join(dir, "tasks.json"), JSON.stringify({ tasks: [1, 2, 3] }));
    expect(await readTaskCount(join(dir, "tasks.json"))).toBe(3);
    await writeFile(join(dir, "bad.json"), JSON.stringify({ notTasks: 1 }));
    expect(await readTaskCount(join(dir, "bad.json"))).toBe(0); // present but wrong shape → 0
    expect(await readTaskCount(join(dir, "missing.json"))).toBeUndefined(); // unreadable → undefined
  });
});

describe("readMcpEntryCount", () => {
  it("counts the mcpServers keys, and degrades to 0 (NOT undefined) when missing/malformed", async () => {
    await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { a: {}, b: {} } }));
    expect(await readMcpEntryCount(join(dir, "mcp.json"))).toBe(2);
    expect(await readMcpEntryCount(join(dir, "absent.json"))).toBe(0);
    await writeFile(join(dir, "junk.json"), "{not json");
    expect(await readMcpEntryCount(join(dir, "junk.json"))).toBe(0);
  });
});
