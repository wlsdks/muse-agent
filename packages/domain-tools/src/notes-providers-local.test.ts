import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotesProviderError, NotesValidationError } from "./notes-providers.js";
import { LocalDirNotesProvider, sliceWithoutLoneSurrogate } from "./notes-providers-local.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "muse-notes-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeProvider(overrides: Partial<{ maxFileBytes: number; maxListEntries: number }> = {}): LocalDirNotesProvider {
  return new LocalDirNotesProvider({ notesDir: dir, ...overrides });
}

describe("LocalDirNotesProvider describe", () => {
  it("rejects an empty notes directory", () => {
    expect(() => new LocalDirNotesProvider({ notesDir: "" })).toThrow(NotesValidationError);
    expect(() => new LocalDirNotesProvider({ notesDir: "   " })).toThrow(NotesValidationError);
  });

  it("rejects non-finite file and result limits", () => {
    expect(() => makeProvider({ maxFileBytes: Number.POSITIVE_INFINITY })).toThrow(NotesValidationError);
    expect(() => makeProvider({ maxListEntries: Number.NaN })).toThrow(NotesValidationError);
  });

  it("reports itself as local with the configured directory", () => {
    const provider = makeProvider();
    const info = provider.describe();
    expect(info.id).toBe("local");
    expect(info.local).toBe(true);
    expect(info.description).toContain(dir);
  });
});

describe("LocalDirNotesProvider save/read round-trip", () => {
  it("saves a new note by title and reads it back", async () => {
    const provider = makeProvider();
    const saved = await provider.save({ body: "hello world", title: "todo.md" });
    expect(saved.id).toBe("todo.md");
    expect(saved.body).toBe("hello world");

    const read = await provider.read("todo.md");
    expect(read?.body).toBe("hello world");
    expect(read?.id).toBe("todo.md");
    expect(read?.updatedAt).toBeInstanceOf(Date);
  });

  it("refuses to overwrite an existing note without overwrite:true", async () => {
    const provider = makeProvider();
    await provider.save({ body: "v1", title: "note.md" });
    await expect(provider.save({ body: "v2", title: "note.md" })).rejects.toThrow(NotesProviderError);
    const read = await provider.read("note.md");
    expect(read?.body).toBe("v1");
  });

  it("overwrites when overwrite:true is passed", async () => {
    const provider = makeProvider();
    await provider.save({ body: "v1", title: "note.md" });
    await provider.save({ body: "v2", overwrite: true, title: "note.md" });
    const read = await provider.read("note.md");
    expect(read?.body).toBe("v2");
  });

  it("creates nested folders on demand", async () => {
    const provider = makeProvider();
    await provider.save({ body: "nested", id: "sub/dir/note.md", title: "note.md" });
    const read = await provider.read("sub/dir/note.md");
    expect(read?.body).toBe("nested");
  });

  it("read() on a missing note returns undefined, never throws", async () => {
    const provider = makeProvider();
    await expect(provider.read("missing.md")).resolves.toBeUndefined();
  });

  it("read() on a directory throws NotesValidationError, not a generic error", async () => {
    const provider = makeProvider();
    await fs.mkdir(join(dir, "afolder"));
    await expect(provider.read("afolder")).rejects.toThrow(NotesValidationError);
  });

  it("rejects a body over maxFileBytes on save", async () => {
    const provider = makeProvider({ maxFileBytes: 1_024 });
    const bigBody = "x".repeat(2_000);
    await expect(provider.save({ body: bigBody, title: "big.md" })).rejects.toThrow(NotesValidationError);
  });
});

describe("LocalDirNotesProvider path sandboxing", () => {
  it("rejects an absolute path", async () => {
    const provider = makeProvider();
    await expect(provider.save({ body: "x", id: "/etc/passwd", title: "x" })).rejects.toThrow(NotesValidationError);
  });

  it("rejects a path that escapes the sandbox via ..", async () => {
    const provider = makeProvider();
    await expect(provider.save({ body: "x", id: "../outside.md", title: "x" })).rejects.toThrow(NotesValidationError);
    await expect(provider.read("../../etc/passwd")).rejects.toThrow(NotesValidationError);
  });

  it("rejects a Windows-style absolute path", async () => {
    const provider = makeProvider();
    await expect(provider.save({ body: "x", id: "C:\\Windows\\note.md", title: "x" })).rejects.toThrow(NotesValidationError);
  });
});

describe("LocalDirNotesProvider list", () => {
  it("lists only .md/.markdown/.txt files, skipping dotfiles and other extensions", async () => {
    const provider = makeProvider();
    await provider.save({ body: "a", title: "a.md" });
    await provider.save({ body: "b", title: "b.txt" });
    await provider.save({ body: "c", title: "c.markdown" });
    await fs.writeFile(join(dir, "ignored.json"), "{}", "utf8");
    await fs.writeFile(join(dir, ".hidden.md"), "hidden", "utf8");

    const listed = await provider.list();
    const titles = listed.map((e) => e.title).sort();
    expect(titles).toEqual(["a.md", "b.txt", "c.markdown"]);
  });

  it("includes sizeBytes and updatedAt when stat succeeds", async () => {
    const provider = makeProvider();
    await provider.save({ body: "hello", title: "a.md" });
    const listed = await provider.list();
    expect(listed[0]?.sizeBytes).toBeGreaterThan(0);
    expect(listed[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it("list on an empty directory returns empty", async () => {
    const provider = makeProvider();
    await expect(provider.list()).resolves.toEqual([]);
  });

  it("throws NotesProviderError when listing a nonexistent folder", async () => {
    const provider = makeProvider();
    await expect(provider.list("nope")).rejects.toThrow(NotesProviderError);
  });

  it("caps at maxListEntries", async () => {
    const provider = makeProvider({ maxListEntries: 2 });
    await provider.save({ body: "a", title: "a.md" });
    await provider.save({ body: "b", title: "b.md" });
    await provider.save({ body: "c", title: "c.md" });
    const listed = await provider.list();
    expect(listed).toHaveLength(2);
  });
});

describe("LocalDirNotesProvider search", () => {
  it("finds line-level hits with 1-based line numbers, case-insensitive", async () => {
    const provider = makeProvider();
    await provider.save({ body: "line one\nfind ME here\nline three", title: "a.md" });
    const hits = await provider.search("find me", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "a.md", line: 2, snippet: "find ME here" });
  });

  it("searches recursively into subfolders", async () => {
    const provider = makeProvider();
    await provider.save({ body: "needle here", id: "sub/nested.md", title: "nested.md" });
    const hits = await provider.search("needle", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("sub/nested.md");
  });

  it("truncates an overlong snippet line to 240 chars", async () => {
    const provider = makeProvider();
    const longLine = `needle ${"x".repeat(300)}`;
    await provider.save({ body: longLine, title: "long.md" });
    const hits = await provider.search("needle", 10);
    expect(hits[0]?.snippet.length).toBeLessThanOrEqual(243);
    expect(hits[0]?.snippet.endsWith("...")).toBe(true);
  });

  it("rejects an empty query", async () => {
    const provider = makeProvider();
    await expect(provider.search("", 10)).rejects.toThrow(NotesValidationError);
  });

  it("rejects a non-finite result limit", async () => {
    const provider = makeProvider();
    await expect(provider.search("match", Number.POSITIVE_INFINITY)).rejects.toThrow(NotesValidationError);
  });

  it("caps hits at the requested limit across files", async () => {
    const provider = makeProvider();
    for (let n = 0; n < 5; n += 1) {
      await provider.save({ body: `match ${n.toString()}`, title: `note${n.toString()}.md` });
    }
    const hits = await provider.search("match", 2);
    expect(hits).toHaveLength(2);
  });

  it("skips files over maxFileBytes rather than throwing", async () => {
    const provider = makeProvider({ maxFileBytes: 1_024 });
    await fs.writeFile(join(dir, "huge.md"), `needle ${"x".repeat(2_000)}`, "utf8");
    await expect(provider.search("needle", 10)).resolves.toEqual([]);
  });
});

describe("LocalDirNotesProvider append", () => {
  it("appends to an existing note and returns the full updated body", async () => {
    const provider = makeProvider();
    await provider.save({ body: "line one\n", title: "log.md" });
    const appended = await provider.append({ body: "line two\n", id: "log.md" });
    expect(appended.body).toBe("line one\nline two\n");
  });

  it("creates the note (and parent folders) if it doesn't exist yet", async () => {
    const provider = makeProvider();
    const appended = await provider.append({ body: "first line", id: "new/dir/log.md" });
    expect(appended.body).toBe("first line");
  });

  it("rejects an append that pushes the file over maxFileBytes", async () => {
    // maxFileBytes has an internal floor of 1024 (`Math.max(1_024, ...)`), so
    // the initial body and the appended chunk must together clear that floor.
    const provider = makeProvider({ maxFileBytes: 2_000 });
    await provider.save({ body: "x".repeat(1_500), title: "small.md" });
    await expect(provider.append({ body: "y".repeat(1_000), id: "small.md" })).rejects.toThrow(NotesProviderError);
    await expect(provider.read("small.md")).resolves.toMatchObject({ body: "x".repeat(1_500) });
  });
});

describe("LocalDirNotesProvider delete", () => {
  it("deletes an existing note and returns true", async () => {
    const provider = makeProvider();
    await provider.save({ body: "bye", title: "gone.md" });
    await expect(provider.delete!("gone.md")).resolves.toBe(true);
    await expect(provider.read("gone.md")).resolves.toBeUndefined();
  });

  it("returns false for a note that doesn't exist, never throws", async () => {
    const provider = makeProvider();
    await expect(provider.delete!("missing.md")).resolves.toBe(false);
  });

  it("throws NotesValidationError when the target is a directory", async () => {
    const provider = makeProvider();
    await fs.mkdir(join(dir, "afolder"));
    await expect(provider.delete!("afolder")).rejects.toThrow(NotesValidationError);
  });
});

describe("sliceWithoutLoneSurrogate", () => {
  it("slices normally when the cut point isn't inside a surrogate pair", () => {
    expect(sliceWithoutLoneSurrogate("hello world", 5)).toBe("hello");
  });

  it("drops a trailing lone high surrogate rather than emitting invalid UTF-16", () => {
    const withEmoji = `abcd${String.fromCodePoint(0x1f600)}`; // "abcd" + high+low surrogate pair
    // Cut right after the high surrogate (index 5) to force a lone surrogate at the boundary.
    const sliced = sliceWithoutLoneSurrogate(withEmoji, 5);
    expect(sliced).toBe("abcd");
    const lastCode = sliced.charCodeAt(sliced.length - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
  });
});

describe("LocalDirNotesProvider mutation check (teeth)", () => {
  it("would fail if search() didn't cap at the requested limit", async () => {
    // Contract: search() must stop collecting once `matches.length >= cap`.
    // If the source's `if (matches.length >= cap) break;` inside the file
    // loop were removed, this test goes RED because 5 files each with a
    // match would return 5 hits instead of the requested 2.
    const provider = makeProvider();
    for (let n = 0; n < 5; n += 1) {
      await provider.save({ body: "hit", title: `f${n.toString()}.md` });
    }
    const hits = await provider.search("hit", 2);
    expect(hits.length).toBe(2);
  });
});
