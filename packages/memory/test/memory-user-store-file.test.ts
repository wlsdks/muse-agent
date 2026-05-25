import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileUserMemoryStore } from "../src/index.js";

async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), "muse-user-mem-"));
  const file = join(dir, "user-memory.json");
  return { dir, file, store: new FileUserMemoryStore({ file, now: () => new Date("2026-05-12T10:00:00Z") }) };
}

describe("FileUserMemoryStore", () => {
  it("returns undefined when the file doesn't exist yet", async () => {
    const { store } = await newStore();
    expect(await store.findByUserId("stark")).toBeUndefined();
  });

  it("persists upserts to disk so a new store instance reads them back", async () => {
    const { file, store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");
    await store.upsertPreference("stark", "reply_style", "concise");

    const reread = new FileUserMemoryStore({ file });
    const memory = await reread.findByUserId("stark");
    expect(memory?.facts).toEqual({ name: "Stark" });
    expect(memory?.preferences).toEqual({ reply_style: "concise" });
    expect(memory?.recentTopics).toEqual([]);
  });

  it("forget removes one fact/preference key, leaves the rest, and reports whether it hit", async () => {
    const { file, store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");
    await store.upsertFact("stark", "city", "Seoul");
    await store.upsertPreference("stark", "night_owl", "true");

    expect(await store.forget("stark", "city")).toBe(true);
    expect(await store.forget("stark", "night_owl")).toBe(true);
    expect(await store.forget("stark", "missing")).toBe(false);
    expect(await store.forget("nobody", "name")).toBe(false);

    const reread = new FileUserMemoryStore({ file });
    const memory = await reread.findByUserId("stark");
    expect(memory?.facts).toEqual({ name: "Stark" });
    expect(memory?.preferences).toEqual({});
  });

  it("re-confirming an existing fact moves it to the tail (so the persona's freshest-N cap keeps it)", async () => {
    const { file, store } = await newStore();
    await store.upsertFact("stark", "a", "1");
    await store.upsertFact("stark", "b", "2");
    await store.upsertFact("stark", "c", "3");
    await store.upsertFact("stark", "a", "1-again");

    const reread = new FileUserMemoryStore({ file });
    const memory = await reread.findByUserId("stark");
    expect(Object.keys(memory?.facts ?? {})).toEqual(["b", "c", "a"]);
    expect(memory?.facts.a).toBe("1-again");
  });

  it("retains a fact's prior value in factHistory when overwritten with a different value", async () => {
    const { file, store } = await newStore();
    await store.upsertFact("stark", "home_city", "Busan");
    await store.upsertFact("stark", "home_city", "Seoul");

    const reread = new FileUserMemoryStore({ file });
    const memory = await reread.findByUserId("stark");
    expect(memory?.facts.home_city).toBe("Seoul");
    expect(memory?.factHistory).toEqual([
      { key: "home_city", previousValue: "Busan", replacedAt: new Date("2026-05-12T10:00:00Z") }
    ]);
  });

  it("does not log history for a brand-new key or an unchanged re-confirmation", async () => {
    const { store } = await newStore();
    await store.upsertFact("stark", "home_city", "Seoul");
    await store.upsertFact("stark", "home_city", "Seoul");
    const memory = await store.findByUserId("stark");
    expect(memory?.factHistory).toBeUndefined();
  });

  it("multi-user isolation — facts for one userId don't leak to another", async () => {
    const { store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");
    await store.upsertFact("rhodes", "name", "Rhodey");
    const stark = await store.findByUserId("stark");
    const rhodes = await store.findByUserId("rhodes");
    expect(stark?.facts).toEqual({ name: "Stark" });
    expect(rhodes?.facts).toEqual({ name: "Rhodey" });
  });

  it("atomically replaces the file (tmp + rename) so concurrent reads see a consistent shape", async () => {
    const { file, store } = await newStore();
    await store.upsertFact("stark", "city", "Seoul");
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.users.stark.facts.city).toBe("Seoul");
  });

  it("updates the updatedAt timestamp on every upsert", async () => {
    const { store } = await newStore();
    const first = await store.upsertFact("stark", "name", "Stark");
    const second = await store.upsertPreference("stark", "reply_style", "concise");
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it("delete returns true when the user existed, false otherwise", async () => {
    const { store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");
    expect(await store.deleteByUserId("stark")).toBe(true);
    expect(await store.deleteByUserId("stark")).toBe(false);
    expect(await store.findByUserId("stark")).toBeUndefined();
  });

  it("tolerates a missing file after delete then re-creates on next write", async () => {
    const { file, store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");
    await unlink(file);
    await store.upsertFact("stark", "city", "Seoul");
    const memory = await store.findByUserId("stark");
    expect(memory?.facts).toEqual({ city: "Seoul" }); // prior "name" lost because file was wiped
  });

  it("serialises concurrent upserts per-file so two writes landing in the same tick both persist instead of the second clobbering the first (pre-fix the unserialised read-modify-write lost the first caller's update when the auto-extract `afterComplete` hook fired while a /remember slash-command was mid-flight)", async () => {
    const { store } = await newStore();
    await Promise.all([
      store.upsertFact("stark", "name", "Tony"),
      store.upsertPreference("stark", "tone", "concise")
    ]);
    const memory = await store.findByUserId("stark");
    expect(memory?.facts).toEqual({ name: "Tony" });
    expect(memory?.preferences).toEqual({ tone: "concise" });
  });

  it("serialises concurrent upserts across DIFFERENT users — `/fact` calls for two users in the same tick both land, neither user's row is dropped", async () => {
    const { store } = await newStore();
    await Promise.all([
      store.upsertFact("stark", "name", "Tony"),
      store.upsertFact("rhodes", "name", "Rhodey"),
      store.upsertFact("pepper", "name", "Pepper")
    ]);
    const stark = await store.findByUserId("stark");
    const rhodes = await store.findByUserId("rhodes");
    const pepper = await store.findByUserId("pepper");
    expect(stark?.facts).toEqual({ name: "Tony" });
    expect(rhodes?.facts).toEqual({ name: "Rhodey" });
    expect(pepper?.facts).toEqual({ name: "Pepper" });
  });

  it("upsertFact / upsertPreference strip ANSI / control bytes from value (defense-in-depth)", async () => {
    const { store } = await newStore();
    // ESC + CSI + BEL + NUL all need to be gone before this value
    // reaches the persona-expansion path that re-emits it next turn.
    await store.upsertFact("stark", "name", "Tony\x1b[2J\x07\x00Stark");
    await store.upsertPreference("stark", "tone", "concise\x9b31m");
    const memory = await store.findByUserId("stark");
    expect(memory?.facts).toEqual({ name: "Tony[2JStark" });
    expect(memory?.preferences).toEqual({ tone: "concise31m" });
  });
});

describe("sanitizeUserMemoryValue (direct unit tests)", () => {
  it("strips C0 control bytes except newline + tab", async () => {
    const { sanitizeUserMemoryValue } = await import("../src/index.js");
    expect(sanitizeUserMemoryValue("a\x00b\x07c\x1bd")).toBe("abcd");
    expect(sanitizeUserMemoryValue("line1\nline2\tindented")).toBe("line1\nline2\tindented");
  });

  it("strips DEL + C1 high-set range (0x7f-0x9f) — bare CSI is the dangerous one", async () => {
    const { sanitizeUserMemoryValue } = await import("../src/index.js");
    expect(sanitizeUserMemoryValue("title\x7fbody")).toBe("titlebody");
    expect(sanitizeUserMemoryValue("title\x9b31mEVIL")).toBe("title31mEVIL");
  });

  it("redacts credential shapes before persisting (goal 182)", async () => {
    const { sanitizeUserMemoryValue } = await import("../src/index.js");
    expect(sanitizeUserMemoryValue("deploy token is ghp_abcdefghijklmnopqrstuvwxyzABCDEF"))
      .not.toContain("ghp_abcdefghijklmnopqrstuvwxyzABCDEF");
    expect(sanitizeUserMemoryValue("my key sk-proj-abcdefghijklmnopqrstuvwxyz"))
      .not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    // Plain prose is untouched.
    expect(sanitizeUserMemoryValue("prefers dark mode and tea")).toBe("prefers dark mode and tea");
  });

  it("caps oversized values at MAX_USER_MEMORY_VALUE_CHARS", async () => {
    const { sanitizeUserMemoryValue, MAX_USER_MEMORY_VALUE_CHARS } = await import("../src/index.js");
    const big = "x".repeat(MAX_USER_MEMORY_VALUE_CHARS + 100);
    expect(sanitizeUserMemoryValue(big).length).toBe(MAX_USER_MEMORY_VALUE_CHARS);
  });

  it("drops a lone high surrogate when the cap lands inside a surrogate pair (goal-451/499/500 sibling)", async () => {
    const { sanitizeUserMemoryValue, MAX_USER_MEMORY_VALUE_CHARS } = await import("../src/index.js");
    // The persona-expansion path re-injects this value into every
    // prompt; a stray high surrogate at the boundary would corrupt
    // the prompt and any downstream JSON/SSE/messaging echo.
    const padding = "x".repeat(MAX_USER_MEMORY_VALUE_CHARS - 1);
    const value = padding + "😀" + "yyyyyy";
    const result = sanitizeUserMemoryValue(value);
    // No lone high surrogate at the truncation boundary.
    expect(result.charCodeAt(result.length - 1)).not.toSatisfy(
      (c: number) => c >= 0xd800 && c <= 0xdbff
    );
    // The "😀"'s high surrogate sat at index MAX_USER_MEMORY_VALUE_CHARS-1
    // (the last kept slot). With the drop, the result is just the
    // padding — the entire pair is excluded.
    expect(result).toBe(padding);
  });

  it("passes plain ASCII + multi-byte Unicode through unchanged", async () => {
    const { sanitizeUserMemoryValue } = await import("../src/index.js");
    expect(sanitizeUserMemoryValue("간결한 한국어 응답을 선호함")).toBe("간결한 한국어 응답을 선호함");
    expect(sanitizeUserMemoryValue("plain ascii — 42 chars")).toBe("plain ascii — 42 chars");
  });
});
