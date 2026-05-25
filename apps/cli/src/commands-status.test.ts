import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readRagStatus } from "./commands-status.js";

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-status-"));
  const p = join(dir, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

describe("readRagStatus", () => {
  it("reports not-indexed when the index file is missing", async () => {
    expect(await readRagStatus(join(tmpdir(), "does-not-exist-muse-rag.json"))).toEqual({ indexed: false });
  });

  it("reports indexed with the embed model + file count when present", async () => {
    const p = tmpFile("notes-index.json", JSON.stringify({ model: "nomic-embed-text", files: [{ path: "a.md" }, { path: "b.md" }] }));
    expect(await readRagStatus(p)).toEqual({ embedModel: "nomic-embed-text", files: 2, indexed: true });
  });

  it("treats an empty file list as not-indexed (no chunks to search)", async () => {
    const p = tmpFile("empty-index.json", JSON.stringify({ model: "nomic-embed-text", files: [] }));
    expect(await readRagStatus(p)).toEqual({ embedModel: "nomic-embed-text", files: 0, indexed: false });
  });

  it("omits the embed model when it's blank/missing but still counts files", async () => {
    const p = tmpFile("no-model.json", JSON.stringify({ model: "   ", files: [{ path: "a.md" }] }));
    expect(await readRagStatus(p)).toEqual({ files: 1, indexed: true });
  });
});
