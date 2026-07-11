import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNotesMcpServer, deriveMirrorNoteTitle, type NoteMirror } from "../src/index.js";

const toolNamed = (server: ReturnType<typeof createNotesMcpServer>, name: string) => {
  const t = server.tools.find((e) => e.name === name);
  if (!t) throw new Error(`${name} tool not found`);
  return t;
};

/** A recording mirror spy that succeeds. */
function recordingMirror(): { calls: Array<{ title: string; body: string }>; mirror: NoteMirror } {
  const calls: Array<{ title: string; body: string }> = [];
  const mirror: NoteMirror = async (note) => {
    calls.push({ body: note.body, title: note.title });
    return { mirrored: true };
  };
  return { calls, mirror };
}

describe("muse.notes save — Apple Notes mirror injection (create-only)", () => {
  it("fires the mirror EXACTLY ONCE on a genuine create, with the derived title + full body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-mirror-"));
    const { calls, mirror } = recordingMirror();
    const server = createNotesMcpServer({ notesDir: dir, mirror });
    const content = "# Meeting notes\n\nfollow up with Sam";
    const out = (await toolNamed(server, "save").execute({ path: "meeting.md", content })) as { created?: boolean; mirrorNote?: string };
    expect(out.created).toBe(true);
    expect(out.mirrorNote).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ body: content, title: "Meeting notes" });
    // The Muse-side file is exactly what was written — the mirror never mutates it.
    expect(readFileSync(join(dir, "meeting.md"), "utf8")).toBe(content);
  });

  it("does NOT fire on an OVERWRITE of an existing note (edit, not create)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-mirror-ow-"));
    const { calls, mirror } = recordingMirror();
    const server = createNotesMcpServer({ notesDir: dir, mirror });
    writeFileSync(join(dir, "n.md"), "OLD", "utf8");
    const out = (await toolNamed(server, "save").execute({ path: "n.md", content: "NEW", overwrite: true })) as { created?: boolean };
    expect(out.created).toBe(false);
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(dir, "n.md"), "utf8")).toBe("NEW");
  });

  it("does NOT fire on append (append is not a create surface)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-mirror-app-"));
    const { calls, mirror } = recordingMirror();
    const server = createNotesMcpServer({ notesDir: dir, mirror });
    const out = await toolNamed(server, "append").execute({ path: "log.md", content: "one line\n" });
    expect(out).not.toHaveProperty("error");
    expect(calls).toHaveLength(0);
  });

  it("does NOT fire on delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-mirror-del-"));
    const { calls, mirror } = recordingMirror();
    const server = createNotesMcpServer({ notesDir: dir, mirror });
    writeFileSync(join(dir, "d.md"), "x", "utf8");
    const out = await toolNamed(server, "delete").execute({ path: "d.md" });
    expect(out).toEqual({ deleted: true, path: "d.md" });
    expect(calls).toHaveLength(0);
  });

  it("makes ZERO mirror calls when no mirror is injected (consent pin, wiring layer)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-nomirror-"));
    const server = createNotesMcpServer({ notesDir: dir });
    const out = (await toolNamed(server, "save").execute({ path: "n.md", content: "hi" })) as { created?: boolean; mirrorNote?: string };
    expect(out.created).toBe(true);
    expect(out.mirrorNote).toBeUndefined();
  });
});

describe("muse.notes save — mirror is fail-soft (never fails the Muse write)", () => {
  it("surfaces a mirror WARNING as mirrorNote, leaving the file byte-identical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-mirror-warn-"));
    const mirror: NoteMirror = async () => ({ mirrored: false, warning: "Apple Notes mirror failed: boom" });
    const server = createNotesMcpServer({ notesDir: dir, mirror });
    const content = "content that must survive";
    const out = (await toolNamed(server, "save").execute({ path: "n.md", content })) as { created?: boolean; mirrorNote?: string };
    expect(out.created).toBe(true);
    expect(out.mirrorNote).toBe("Apple Notes mirror failed: boom");
    expect(readFileSync(join(dir, "n.md"), "utf8")).toBe(content);
  });

  it("swallows a mirror that THROWS — the save still succeeds and the file is byte-identical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-mirror-throw-"));
    const mirror: NoteMirror = async () => { throw new Error("kaboom"); };
    const server = createNotesMcpServer({ notesDir: dir, mirror });
    const content = "durable body";
    const out = (await toolNamed(server, "save").execute({ path: "n.md", content })) as { created?: boolean; mirrorNote?: string };
    expect(out.created).toBe(true);
    expect(out.mirrorNote).toContain("kaboom");
    expect(readFileSync(join(dir, "n.md"), "utf8")).toBe(content);
  });
});

describe("deriveMirrorNoteTitle", () => {
  it("uses the first Markdown heading when present", () => {
    expect(deriveMirrorNoteTitle("x/y.md", "# Real Title\n\nbody")).toBe("Real Title");
    expect(deriveMirrorNoteTitle("x/y.md", "### Sub heading ###\nbody")).toBe("Sub heading");
  });
  it("falls back to the basename stem when there is no heading", () => {
    expect(deriveMirrorNoteTitle("inbox/2026-07-07.md", "no heading here")).toBe("2026-07-07");
    expect(deriveMirrorNoteTitle("q3-budget.markdown", "plain")).toBe("q3-budget");
  });
  it("never returns empty", () => {
    expect(deriveMirrorNoteTitle("", "").length).toBeGreaterThan(0);
  });
});
