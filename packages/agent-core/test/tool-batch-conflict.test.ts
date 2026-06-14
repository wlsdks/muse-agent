import type { ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { CONFLICT_IDENTITY_KEYS, detectConflictingWritesInBatch } from "../src/index.js";

// Intra-batch conflicting-write guard (AgentSpec arXiv:2503.18666): a 2nd write to
// the same target with conflicting args in one batch is flagged for withholding.

const call = (id: string, name: string, args: Record<string, unknown>): ModelToolCall => ({
  id,
  name,
  arguments: args as ModelToolCall["arguments"]
});
const allWrite = (): boolean => true;
const allRead = (): boolean => false;

describe("detectConflictingWritesInBatch (AgentSpec arXiv:2503.18666)", () => {
  it("flags the 2nd write to the same target with conflicting args", () => {
    const flagged = detectConflictingWritesInBatch([
      call("c1", "calendar_add", { title: "Standup", startsAt: "3pm" }),
      call("c2", "calendar_add", { title: "Standup", startsAt: "4pm" })
    ], allWrite);
    expect([...flagged]).toEqual(["c2"]); // first kept, conflicting second blocked
  });

  it("does NOT flag two writes to DIFFERENT targets (legitimate batch)", () => {
    const flagged = detectConflictingWritesInBatch([
      call("c1", "calendar_add", { title: "Mon Standup", startsAt: "9am" }),
      call("c2", "calendar_add", { title: "Tue Review", startsAt: "10am" })
    ], allWrite);
    expect(flagged.size).toBe(0); // different titles → different events → both run
  });

  it("does NOT flag byte-identical writes (the deduplicator's job, not a conflict)", () => {
    const flagged = detectConflictingWritesInBatch([
      call("c1", "calendar_add", { title: "Standup", startsAt: "3pm" }),
      call("c2", "calendar_add", { title: "Standup", startsAt: "3pm" })
    ], allWrite);
    expect(flagged.size).toBe(0);
  });

  it("never flags reads (a read isMutating=false is idempotent)", () => {
    const flagged = detectConflictingWritesInBatch([
      call("c1", "web_search", { query: "x" }),
      call("c2", "web_search", { query: "x", page: 2 })
    ], allRead);
    expect(flagged.size).toBe(0);
  });

  it("fail-open: a write with no recognised identity arg is not flagged", () => {
    const flagged = detectConflictingWritesInBatch([
      call("c1", "reminder_add", { dueAt: "tomorrow", note: "a" }),
      call("c2", "reminder_add", { dueAt: "friday", note: "b" })
    ], allWrite);
    expect(flagged.size).toBe(0); // no id/name/title → unguardable → fail-open
  });

  it("flags every conflicting write after the first for one target (keeps exactly the first)", () => {
    const flagged = detectConflictingWritesInBatch([
      call("c1", "task_add", { title: "Ship v1", dueAt: "mon" }),
      call("c2", "task_add", { title: "Ship v1", dueAt: "tue" }),
      call("c3", "task_add", { title: "Ship v1", dueAt: "wed" })
    ], allWrite);
    expect([...flagged].sort()).toEqual(["c2", "c3"]);
  });

  it("a different tool with the same identity value is not cross-flagged", () => {
    const flagged = detectConflictingWritesInBatch([
      call("c1", "calendar_add", { title: "Standup", startsAt: "3pm" }),
      call("c2", "task_add", { title: "Standup", dueAt: "mon" })
    ], allWrite);
    expect(flagged.size).toBe(0); // different tools → different targets
  });

  it("only the conflicting tool's writes are flagged when mixed with a read", () => {
    let calls = 0;
    const isMutating = (c: ModelToolCall): boolean => { calls += 1; return c.name !== "web_search"; };
    const flagged = detectConflictingWritesInBatch([
      call("c1", "calendar_add", { title: "Standup", startsAt: "3pm" }),
      call("c2", "web_search", { query: "agenda" }),
      call("c3", "calendar_add", { title: "Standup", startsAt: "5pm" })
    ], isMutating);
    expect([...flagged]).toEqual(["c3"]);
    expect(calls).toBe(3);
  });

  it("exports a non-empty identity-key allowlist", () => {
    expect(CONFLICT_IDENTITY_KEYS).toContain("title");
    expect(CONFLICT_IDENTITY_KEYS.length).toBeGreaterThan(0);
  });
});
