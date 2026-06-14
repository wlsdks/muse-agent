import { describe, expect, it } from "vitest";

import { filterTasksByQuery } from "./Tasks.js";

import type { TaskRow } from "../api/types.js";

function task(overrides: Partial<TaskRow>): TaskRow {
  return { id: "t", title: "x", status: "open", createdAt: "2026-06-01T00:00:00.000Z", ...overrides };
}

describe("filterTasksByQuery — client-side text filter (web parity with `tasks list --search`)", () => {
  const tasks = [
    task({ id: "a", title: "Pay the DENTIST bill" }),
    task({ id: "b", title: "Email Bob", notes: "about the dentist referral" }),
    task({ id: "c", title: "Buy milk" })
  ];

  it("keeps tasks whose title matches, case-insensitively", () => {
    expect(filterTasksByQuery(tasks, "dentist").map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("also matches the notes field (like the CLI)", () => {
    expect(filterTasksByQuery(tasks, "referral").map((t) => t.id)).toEqual(["b"]);
  });

  it("an empty / whitespace query returns everything (no filtering)", () => {
    expect(filterTasksByQuery(tasks, "")).toEqual(tasks);
    expect(filterTasksByQuery(tasks, "   ")).toEqual(tasks);
  });

  it("a non-match returns nothing", () => {
    expect(filterTasksByQuery(tasks, "zzz")).toEqual([]);
  });
});
