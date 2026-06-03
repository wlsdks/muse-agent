import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { corpusOnboardingHint, notesCorpusFileCount } from "./commands-ask.js";

describe("corpusOnboardingHint — first-run on-ramp for an empty corpus", () => {
  it("returns a hint naming the concrete ways to add notes when the corpus is empty", () => {
    const hint = corpusOnboardingHint(0);
    expect(hint).toBeDefined();
    expect(hint).toMatch(/corpus is empty/i);
    // points at every real on-ramp built for the front door
    expect(hint).toContain("muse demo");
    expect(hint).toContain("--save-to-notes");
    expect(hint).toContain("watch-folder --ingest");
  });

  it("returns undefined once ANY note exists — a normal no-match answer is never cluttered", () => {
    expect(corpusOnboardingHint(1)).toBeUndefined();
    expect(corpusOnboardingHint(42)).toBeUndefined();
  });

  it("is SUPPRESSED when the user has other personal data (contacts/tasks/memory) even with zero notes", () => {
    // A user who set Muse up with contacts/tasks/memory shouldn't be told "Muse
    // only answers from notes" and nagged to add notes on the same turn it answers
    // from their address book.
    expect(corpusOnboardingHint(0, true)).toBeUndefined();
  });

  it("STILL shows for a genuinely empty Muse (no notes AND no other data)", () => {
    expect(corpusOnboardingHint(0, false)).toBeDefined();
    expect(corpusOnboardingHint(0)).toBeDefined(); // default arg = no other data
  });
});

describe("notesCorpusFileCount — the true 'has a corpus' signal (disk, not index)", () => {
  it("counts note files recursively, ignores non-note + hidden, so a down-embedding corpus isn't falsely 'empty'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-corpuscount-"));
    try {
      await writeFile(join(dir, "a.md"), "x", "utf8");
      await writeFile(join(dir, "b.txt"), "y", "utf8");
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "sub", "c.pdf"), "z", "utf8");
      await writeFile(join(dir, "ignore.json"), "{}", "utf8"); // not a note ext
      await writeFile(join(dir, ".hidden.md"), "h", "utf8"); // hidden → skipped
      expect(await notesCorpusFileCount(dir)).toBe(3);
      // This is exactly the state when Ollama is down: files exist on disk,
      // so the onboarding hint must NOT fire even though the index is empty.
      expect(corpusOnboardingHint(await notesCorpusFileCount(dir))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 for a missing or empty dir → the on-ramp hint fires", async () => {
    expect(await notesCorpusFileCount("/no/such/dir/xyz")).toBe(0);
    const empty = await mkdtemp(join(tmpdir(), "muse-corpusempty-"));
    try {
      expect(await notesCorpusFileCount(empty)).toBe(0);
      expect(corpusOnboardingHint(await notesCorpusFileCount(empty))).toBeDefined();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
