import { describe, expect, it } from "vitest";

import { homeCapabilities } from "./home-logic.js";
import { factLabel, groupFactsByValue } from "../lib/memory-labels.js";

describe("homeCapabilities — entries appear only when actually available", () => {
  it("always offers the local-store capabilities", () => {
    const ids = homeCapabilities({ emailConfigured: false, threadCount: 0 }).map((c) => c.id);
    expect(ids).toEqual(["notes", "calendar", "reminder"]);
  });

  it("adds email only when configured", () => {
    const ids = homeCapabilities({ emailConfigured: true, threadCount: 0 }).map((c) => c.id);
    expect(ids).toContain("email");
  });

  it("adds thread resume only when a thread exists, navigating not prompting", () => {
    const caps = homeCapabilities({ emailConfigured: false, threadCount: 2 });
    const threads = caps.find((c) => c.id === "threads");
    expect(threads?.navigate).toBe("continuity");
    expect(threads?.promptKey).toBeUndefined();
  });
});

describe("factLabel — no raw snake_case in the UI", () => {
  it("maps known extractor keys per language", () => {
    expect(factLabel("dog_name", "ko")).toBe("강아지 이름");
    expect(factLabel("dog_name", "en")).toBe("Dog's name");
    expect(factLabel("user_name", "ko")).toBe("이름");
  });

  it("prettifies unknown keys instead of leaking snake_case", () => {
    expect(factLabel("favorite_editor", "ko")).toBe("Favorite editor");
    expect(factLabel("favorite_editor", "en")).toBe("Favorite editor");
  });
});

describe("groupFactsByValue — one entity, one row, nothing hidden", () => {
  it("merges keys sharing a value and keeps first-seen order", () => {
    const groups = groupFactsByValue({ user_name: "진안", dog_name: "보리", cat_name: "보리", pet_dog_name: "보리" });
    expect(groups).toEqual([
      { keys: ["user_name"], value: "진안" },
      { keys: ["dog_name", "cat_name", "pet_dog_name"], value: "보리" }
    ]);
  });

  it("keeps distinct values apart", () => {
    expect(groupFactsByValue({ a: "x", b: "y" })).toHaveLength(2);
  });

  it("handles empty facts", () => {
    expect(groupFactsByValue({})).toEqual([]);
  });
});
