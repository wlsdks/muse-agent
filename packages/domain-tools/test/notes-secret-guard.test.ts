import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNotesMcpServer } from "../src/index.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-notes-secret-guard-"));
}

function tool(dir: string, name: string) {
  const found = createNotesMcpServer({ notesDir: dir }).tools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} tool not found`);
  return found;
}

describe("muse.notes save/append — fail-close secret-persistence guard", () => {
  it("save: refuses a plaintext password and writes NOTHING to disk", async () => {
    const dir = freshDir();
    const out = await tool(dir, "save").execute({ path: "creds.md", content: "내 비밀번호 hunter2를 저장해줘" }) as {
      error?: string;
      blocked?: boolean;
      kinds?: readonly string[];
    };
    expect(out.blocked).toBe(true);
    expect(out.error).toContain("암호화");
    expect(out.kinds).toContain("credential-label");
    expect(existsSync(join(dir, "creds.md"))).toBe(false);
    expect(readdirSync(dir).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  it("save: an ordinary note still writes normally (no over-block regression)", async () => {
    const dir = freshDir();
    const out = await tool(dir, "save").execute({ path: "policy.md", content: "비밀번호 정책 노트에 적어줘: 12자 이상, 분기마다 변경" }) as {
      error?: string;
      created?: boolean;
    };
    expect(out.error).toBeUndefined();
    expect(out.created).toBe(true);
    expect(existsSync(join(dir, "policy.md"))).toBe(true);
  });

  it("append: refuses an API key and leaves the existing note untouched", async () => {
    const dir = freshDir();
    await tool(dir, "save").execute({ path: "log.md", content: "day one\n" });
    const before = readdirSync(dir);
    const out = await tool(dir, "append").execute({ path: "log.md", content: "\nkey: sk-proj-abcdefghijklmnopqrstuvwxyz" }) as {
      error?: string;
      blocked?: boolean;
    };
    expect(out.blocked).toBe(true);
    expect(out.error).toContain("암호화");
    expect(readdirSync(dir)).toEqual(before);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(dir, "log.md"), "utf8")).toBe("day one\n");
  });

  it("append: ordinary journal content still appends normally (no over-block regression)", async () => {
    const dir = freshDir();
    await tool(dir, "save").execute({ path: "journal.md", content: "day one\n" });
    const out = await tool(dir, "append").execute({ path: "journal.md", content: "day two: had lunch with Bob" }) as { error?: string };
    expect(out.error).toBeUndefined();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(dir, "journal.md"), "utf8")).toBe("day one\nday two: had lunch with Bob");
  });
});
