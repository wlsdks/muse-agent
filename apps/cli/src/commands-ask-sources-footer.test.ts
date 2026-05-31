import { describe, expect, it } from "vitest";

import { formatSourcesFooter } from "./commands-ask.js";

describe("formatSourcesFooter — followable openable-path receipt", () => {
  it("lists each CITED note with its full openable path under the notes dir", () => {
    const out = formatSourcesFooter("MTU is 1380 [from notes/vpn.md] and rent is due [from tasks/rent.md].", "/home/u/.muse/notes");
    expect(out).toContain("📎 Sources (open to verify):");
    expect(out).toContain("/home/u/.muse/notes/notes/vpn.md");
    expect(out).toContain("/home/u/.muse/notes/tasks/rent.md");
  });

  it("returns undefined when the answer cites nothing (no footer)", () => {
    expect(formatSourcesFooter("I'm not sure — nothing in your notes covers that.", "/home/u/.muse/notes")).toBeUndefined();
  });

  it("dedups a note cited more than once", () => {
    const out = formatSourcesFooter("A [from notes/vpn.md]. B [from notes/vpn.md].", "/n") ?? "";
    expect(out.match(/vpn\.md/gu)?.length).toBe(1);
  });

  it("keeps an already-absolute cited path as-is (not double-joined)", () => {
    const out = formatSourcesFooter("X [from /abs/note.md].", "/home/u/.muse/notes") ?? "";
    expect(out).toContain("   /abs/note.md");
    expect(out).not.toContain("/home/u/.muse/notes/abs");
  });
});
