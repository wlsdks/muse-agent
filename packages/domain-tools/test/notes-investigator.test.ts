import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalDirNotesProvider, createNotesInvestigator } from "../src/index.js";

describe("createNotesInvestigator — P0-b3 production investigator over real notes", () => {
  function seededProvider() {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-inv-"));
    writeFileSync(join(dir, "q3-review-plan.md"), "# Plan\nQ3 review agenda and quarterly metrics\n");
    writeFileSync(join(dir, "groceries.md"), "milk, eggs, bread\n");
    return new LocalDirNotesProvider({ notesDir: dir });
  }

  it("surfaces a finding citing the real note for a matching imminent item", async () => {
    const provider = seededProvider();
    const investigate = createNotesInvestigator((q, l) => provider.search(q, l));
    const finding = await investigate({ factSheet: "Q3 review at 3pm", kind: "calendar", title: "Q3 review" });
    expect(finding).toContain("Related notes:");
    expect(finding).toContain("q3-review-plan.md");
  });

  it("returns undefined when the topic has no related note", async () => {
    const provider = seededProvider();
    const investigate = createNotesInvestigator((q, l) => provider.search(q, l));
    expect(await investigate({ factSheet: "", kind: "calendar", title: "Dentist appointment xyz" })).toBeUndefined();
  });

  it("returns undefined for an empty item title (never calls search)", async () => {
    let called = false;
    const investigate = createNotesInvestigator(async () => {
      called = true;
      return [];
    });
    expect(await investigate({ factSheet: "", kind: "task", title: "   " })).toBeUndefined();
    expect(called).toBe(false);
  });

  it("fail-soft: a throwing search yields undefined (the notice still fires)", async () => {
    const investigate = createNotesInvestigator(() => Promise.reject(new Error("notes index unreadable")));
    expect(await investigate({ factSheet: "", kind: "task", title: "anything" })).toBeUndefined();
  });
});
