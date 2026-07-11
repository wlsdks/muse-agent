import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNotesRegistryMcpServer } from "../src/loopback-notes-registry.js";
import { LocalDirNotesProvider, NotesProviderRegistry } from "../src/notes-providers.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-notes-registry-secret-guard-"));
}

function serverFor(dir: string) {
  const registry = new NotesProviderRegistry([new LocalDirNotesProvider({ notesDir: dir })]);
  return createNotesRegistryMcpServer({ registry });
}

function tool(dir: string, name: string) {
  const found = serverFor(dir).tools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} tool not found`);
  return found;
}

describe("muse.notes-multi save/append — fail-close secret-persistence guard", () => {
  it("save: refuses a plaintext password and writes NOTHING to disk", async () => {
    const dir = freshDir();
    const out = await tool(dir, "save").execute({ title: "비밀번호", body: "내 비밀번호 hunter2 저장" }) as {
      error?: string;
      blocked?: boolean;
      kinds?: readonly string[];
    };
    expect(out.blocked).toBe(true);
    expect(out.error).toBeTruthy();
    expect(out.kinds).toContain("credential-label");
    expect(readdirSync(dir).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  it("save: ordinary content still writes normally (no over-block regression)", async () => {
    const dir = freshDir();
    const out = await tool(dir, "save").execute({ title: "회의록", body: "회의록: API 설계 논의함" }) as {
      error?: string;
      note?: { id: string };
    };
    expect(out.error).toBeUndefined();
    expect(out.note).toBeTruthy();
    const entries = readdirSync(dir).filter((name) => !name.startsWith("."));
    expect(entries.length).toBe(1);
    expect(existsSync(join(dir, entries[0]!))).toBe(true);
  });

  it("append: refuses a secret-bearing body and leaves the existing note untouched", async () => {
    const dir = freshDir();
    const saved = await tool(dir, "save").execute({ title: "log", body: "day one\n" }) as { note: { id: string; body: string } };
    const before = readFileSync(join(dir, saved.note.id), "utf8");
    const out = await tool(dir, "append").execute({
      providerId: "local",
      id: saved.note.id,
      body: "\nkey: sk-proj-abcdefghijklmnopqrstuvwxyz"
    }) as { error?: string; blocked?: boolean };
    expect(out.blocked).toBe(true);
    expect(readFileSync(join(dir, saved.note.id), "utf8")).toBe(before);
  });

  it("append: ordinary content still appends normally (no over-block regression)", async () => {
    const dir = freshDir();
    const saved = await tool(dir, "save").execute({ title: "journal", body: "day one\n" }) as { note: { id: string } };
    const out = await tool(dir, "append").execute({
      providerId: "local",
      id: saved.note.id,
      body: "day two: had lunch with Bob"
    }) as { error?: string };
    expect(out.error).toBeUndefined();
    expect(readFileSync(join(dir, saved.note.id), "utf8")).toBe("day one\nday two: had lunch with Bob");
  });
});
