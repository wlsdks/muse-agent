import { isAbsolute, join } from "node:path";

import { describe, expect, it } from "vitest";

import { relativizeNoteSource } from "./commands-ask.js";

describe("relativizeNoteSource — gate, verdict, and receipt cite the SAME source form", () => {
  const notesDir = "/home/u/.muse/notes";

  it("relativizes an absolute note path to the name the model is shown and cites", () => {
    // The grounding verdict previously validated the answer's `[from q3.md]`
    // citation against the RAW absolute path and falsely flagged a correct
    // answer "treat as unverified". This is the form it must use instead.
    expect(relativizeNoteSource(join(notesDir, "q3.md"), notesDir)).toBe("q3.md");
    expect(relativizeNoteSource(join(notesDir, "projects", "vpn.md"), notesDir)).toBe("projects/vpn.md");
  });

  it("leaves an already-relative source untouched (test corpora pass short names)", () => {
    expect(relativizeNoteSource("policy-2025.pdf", notesDir)).toBe("policy-2025.pdf");
    expect(relativizeNoteSource("notes/lease.md", notesDir)).toBe("notes/lease.md");
  });

  it("never returns an absolute path for a note under the notes dir (so citationValidity can match)", () => {
    const out = relativizeNoteSource(join(notesDir, "lease.md"), notesDir);
    expect(isAbsolute(out)).toBe(false);
  });

  it("uses the BASENAME for an ad-hoc --file path that ESCAPES the notes dir (not an ugly ../../ cite)", () => {
    // `muse ask --file ~/work/RUNBOOK.md` must not cite `[from ../../../work/RUNBOOK.md]`.
    expect(relativizeNoteSource("/home/u/work/RUNBOOK.md", notesDir)).toBe("RUNBOOK.md");
    expect(relativizeNoteSource("/tmp/docs/spec.md", notesDir)).toBe("spec.md");
    // …but an in-corpus nested note still keeps its disambiguating relative path.
    expect(relativizeNoteSource(join(notesDir, "a", "notes.md"), notesDir)).toBe("a/notes.md");
  });
});
