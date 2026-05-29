import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EMPTY_USER_MODEL,
  FileUserMemoryStore,
  composeUserModelSnapshot,
  removeUserModelSlot,
  upsertUserModelSlot,
  type UserPreferenceSlot
} from "../src/index.js";

const AT = new Date("2026-05-01T00:00:00Z");
const pref = (id: string, value: string): UserPreferenceSlot => ({ id, kind: "preference", value, updatedAt: AT });

describe("upsertUserModelSlot / removeUserModelSlot (pure)", () => {
  it("appends a new slot then replaces it by id", () => {
    const m1 = upsertUserModelSlot(EMPTY_USER_MODEL, pref("style", "concise"));
    expect(m1.preferences).toHaveLength(1);
    const m2 = upsertUserModelSlot(m1, pref("style", "concise, bullet points"));
    expect(m2.preferences).toHaveLength(1); // replaced, not duplicated
    expect(m2.preferences[0]!.value).toBe("concise, bullet points");
    const m3 = upsertUserModelSlot(m2, { id: "morning", kind: "schedule", value: "journals", recurrence: "daily 07:00", updatedAt: AT });
    expect(m3.schedule).toHaveLength(1);
    expect(m3.preferences).toHaveLength(1);
  });

  it("removes a slot by id from whichever kind holds it", () => {
    const m = upsertUserModelSlot(upsertUserModelSlot(EMPTY_USER_MODEL, pref("a", "x")), pref("b", "y"));
    expect(removeUserModelSlot(m, "a").preferences.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("FileUserMemoryStore — typed-slot write path persists + renders", () => {
  it("upsertUserModelSlot persists; findByUserId returns it; compose renders it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-usermodel-")), "user-memory.json");
    const store = new FileUserMemoryStore({ file, now: () => AT });
    await store.upsertUserModelSlot("stark", pref("style", "concise, no fluff"));
    await store.upsertUserModelSlot("stark", { id: "diet", kind: "veto", value: "no eggs", updatedAt: AT });

    const snap = await store.findByUserId("stark");
    expect(snap?.userModel?.preferences[0]!.value).toBe("concise, no fluff");
    expect(snap?.userModel?.vetoes[0]!.value).toBe("no eggs");
    const composed = composeUserModelSnapshot(snap!.userModel!);
    expect(composed).toContain("no eggs");
    expect(composed).toContain("concise");

    await store.removeUserModelSlot("stark", "diet");
    expect((await store.findByUserId("stark"))?.userModel?.vetoes).toHaveLength(0);
  });
});
