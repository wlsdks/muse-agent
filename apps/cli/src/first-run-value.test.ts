import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildFirstValueLine,
  contentFreeWelcomePool,
  dataFlagsFromSelection,
  FIRST_RUN_DATA_OPTIONS,
  FIRST_RUN_DATA_STEP_IDS,
  firstValueContextFromDataResult,
  firstValueFactAtoms,
  firstValueLineIsSafe,
  scaffoldStarterSkillsIfEmpty,
  smartDefaultsNote,
  STARTER_SKILLS
} from "./first-run-value.js";

describe("first-run data-connect options — bilingual, backed by setup data", () => {
  it("offers exactly the safe, already-built connectors", () => {
    expect(FIRST_RUN_DATA_OPTIONS.map((o) => o.value)).toEqual([...FIRST_RUN_DATA_STEP_IDS]);
  });

  it("each row carries Korean AND English in its label + hint", () => {
    for (const option of FIRST_RUN_DATA_OPTIONS) {
      const text = `${option.label} ${option.hint}`;
      expect(/[가-힣]/u.test(text)).toBe(true);
      expect(/[A-Za-z]/u.test(text)).toBe(true);
      expect(option.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("dataFlagsFromSelection — chosen ids → setup-data flags", () => {
  it("maps only the selected connectors to true", () => {
    expect(dataFlagsFromSelection(["contacts", "notesMirror"])).toEqual({
      browsing: false,
      contacts: true,
      notesMirror: true,
      remindersMirror: false
    });
  });

  it("an empty selection turns nothing on (the skip = nothing consent pin)", () => {
    expect(dataFlagsFromSelection([])).toEqual({
      browsing: false,
      contacts: false,
      notesMirror: false,
      remindersMirror: false
    });
  });
});

describe("scaffoldStarterSkillsIfEmpty — idempotent starter skills", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-skills-"));
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("writes the starter skills when the dir is empty, then is a no-op on re-run", async () => {
    const first = await scaffoldStarterSkillsIfEmpty(dir);
    expect(first).toBe(STARTER_SKILLS.length);
    const folders = (await readdir(dir)).sort();
    expect(folders).toEqual(STARTER_SKILLS.map((s) => s.name).sort());
    const skillMd = await readFile(join(dir, STARTER_SKILLS[0]!.name, "SKILL.md"), "utf8");
    expect(skillMd).toContain(`name: ${STARTER_SKILLS[0]!.name}`);
    expect(skillMd).toContain("---");

    // Idempotent: a second run must not clobber or re-add anything.
    const second = await scaffoldStarterSkillsIfEmpty(dir);
    expect(second).toBe(0);
  });

  it("does nothing when the user already has a skill (never clobbers)", async () => {
    await writeFile(join(dir, "my-own-skill.md"), "mine", "utf8");
    expect(await scaffoldStarterSkillsIfEmpty(dir)).toBe(0);
  });
});

describe("smartDefaultsNote", () => {
  it("states auto-extract is ON and proactivity stays OFF (opt-in)", () => {
    const note = smartDefaultsNote(2);
    expect(note).toContain("2");
    expect(note.toLowerCase()).toContain("auto-extract");
    expect(note.toLowerCase()).toContain("proactivity");
    expect(note).toContain("OFF");
  });

  it("omits the skills line when nothing was scaffolded", () => {
    expect(smartDefaultsNote(0).toLowerCase()).not.toContain("starter skill");
  });
});

describe("firstValueContextFromDataResult — drops zero counts", () => {
  it("keeps only positive imported/synced counts", () => {
    expect(firstValueContextFromDataResult({ browsing: { synced: 340 }, contacts: { imported: 0 } })).toEqual({
      browsingSynced: 340
    });
    expect(firstValueContextFromDataResult(undefined)).toEqual({});
  });
});

describe("firstValueFactAtoms — only real, short values become atoms", () => {
  it("collects a short name and positive counts; rejects a huge name", () => {
    expect(firstValueFactAtoms({ browsingSynced: 5, contactsImported: 12, userName: "Jinan" })).toEqual([
      "Jinan",
      "12 contacts",
      "5 visits"
    ]);
    expect(firstValueFactAtoms({ userName: "x".repeat(40) })).toEqual([]);
    expect(firstValueFactAtoms({ contactsImported: 0 })).toEqual([]);
  });
});

describe("firstValueLineIsSafe — the fabrication gate (reused companion-line discipline)", () => {
  // MUTATION-CHECK: an invented count (9) absent from the facts MUST be rejected.
  // Weaken this guard (e.g. `return true`) and this assertion flips → the test fails.
  it("rejects a grounded line that invents a count not in the facts", () => {
    expect(firstValueLineIsSafe("You have 9 new visits", ["3 contacts"], true)).toBe(false);
  });

  it("accepts a grounded line whose numbers all come from the facts", () => {
    expect(firstValueLineIsSafe("127 contacts connected", ["127 contacts"], true)).toBe(true);
  });

  it("accepts a short, digit-free content-free welcome", () => {
    expect(firstValueLineIsSafe("반가워요, 여기 있을게요  ·  I'm right here", [], false)).toBe(true);
  });

  it("rejects a content-free line that smuggles in a digit", () => {
    expect(firstValueLineIsSafe("You have 3 things", [], false)).toBe(false);
  });
});

describe("buildFirstValueLine — grounded when real data exists, else content-free", () => {
  it("empty context ⇒ a content-free welcome (never an invented trait, no digits)", () => {
    const result = buildFirstValueLine({});
    expect(result.grounded).toBe(false);
    expect(/\d/u.test(result.line)).toBe(false);
    expect(contentFreeWelcomePool()).toContain(result.line);
  });

  it("a known name ⇒ a grounded line greeting by that exact name", () => {
    const result = buildFirstValueLine({ userName: "Jinan" });
    expect(result.grounded).toBe(true);
    expect(result.line).toContain("Jinan");
  });

  it("a just-connected source ⇒ a grounded line carrying the real count", () => {
    const result = buildFirstValueLine({ contactsImported: 127 });
    expect(result.grounded).toBe(true);
    expect(result.line).toContain("127");
    // Only the real number appears — no other fabricated digit.
    expect((result.line.match(/\d+/gu) ?? []).every((n) => n === "127")).toBe(true);
  });

  it("name + source ⇒ grounded, both the name and the real count present", () => {
    const result = buildFirstValueLine({ contactsImported: 12, userName: "Sam" });
    expect(result.grounded).toBe(true);
    expect(result.line).toContain("Sam");
    expect(result.line).toContain("12");
  });
});
