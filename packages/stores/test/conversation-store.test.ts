import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultConversationsFile,
  FileConversationStore,
  MAX_TURNS_PER_CONVERSATION,
  newConversationId,
  resolveConversationRef,
  type ConversationSummary
} from "../src/conversation-store.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-conversation-store-")), "conversations.json");
}

describe("defaultConversationsFile", () => {
  it("honors MUSE_CONVERSATIONS_FILE", () => {
    expect(defaultConversationsFile({ MUSE_CONVERSATIONS_FILE: "/tmp/x.json" })).toBe("/tmp/x.json");
  });

  it("falls back to ~/.muse/conversations.json", () => {
    expect(defaultConversationsFile({})).toMatch(/\.muse[/\\]conversations\.json$/u);
  });
});

describe("newConversationId", () => {
  it("is short + prefix-addressable (conv_ + 8 hex chars)", () => {
    const id = newConversationId();
    expect(id).toMatch(/^conv_[0-9a-f]{8}$/u);
  });

  it("generates distinct ids across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newConversationId()));
    expect(ids.size).toBe(20);
  });
});

describe("FileConversationStore — round-trip persistence", () => {
  it("appendTurns creates the conversation on first append; a FRESH store instance reads it back", async () => {
    const file = tmpFile();
    const store = new FileConversationStore({ file, now: () => new Date("2026-07-14T09:00:00.000Z") });

    const created = await store.appendTurns("conv_aaaaaaaa", [
      { content: "help me plan the Q3 memo", role: "user" },
      { content: "sure, let's outline it", role: "assistant" }
    ]);
    expect(created.id).toBe("conv_aaaaaaaa");
    expect(created.origin).toBe("cli");
    expect(created.title).toBe("help me plan the Q3 memo");
    expect(created.turns).toHaveLength(2);
    expect(created.createdAt).toBe("2026-07-14T09:00:00.000Z");

    const reopened = new FileConversationStore({ file });
    const found = await reopened.get("conv_aaaaaaaa");
    expect(found?.turns.map((t) => t.content)).toEqual(["help me plan the Q3 memo", "sure, let's outline it"]);
  });

  it("a second appendTurns call on the SAME id appends (not replaces) and bumps updatedAt", async () => {
    const file = tmpFile();
    let now = new Date("2026-07-14T09:00:00.000Z");
    const store = new FileConversationStore({ file, now: () => now });

    await store.appendTurns("c1", [{ content: "first", role: "user" }]);
    now = new Date("2026-07-14T09:05:00.000Z");
    const updated = await store.appendTurns("c1", [{ content: "second", role: "user" }]);

    expect(updated.turns.map((t) => t.content)).toEqual(["first", "second"]);
    expect(updated.createdAt).toBe("2026-07-14T09:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-07-14T09:05:00.000Z");
  });

  it("an explicit title option wins over the derived-from-first-turn title", async () => {
    const file = tmpFile();
    const store = new FileConversationStore({ file });
    const created = await store.appendTurns("c1", [{ content: "hi there", role: "user" }], { title: "imported from last-chat" });
    expect(created.title).toBe("imported from last-chat");
  });

  it("derives the title from the first USER turn's first ~40 chars, not an earlier system turn", async () => {
    const file = tmpFile();
    const store = new FileConversationStore({ file });
    const longUserContent = "x".repeat(60);
    const created = await store.appendTurns("c1", [
      { content: "[SESSION_BOUNDARY]", role: "system" },
      { content: longUserContent, role: "user" }
    ]);
    expect(created.title).toBe(`${"x".repeat(39)}…`);
  });

  it("list() sorts by updatedAt desc and omits turns, carrying turnCount instead", async () => {
    const file = tmpFile();
    let now = new Date("2026-07-14T09:00:00.000Z");
    const store = new FileConversationStore({ file, now: () => now });
    await store.appendTurns("c1", [{ content: "a", role: "user" }, { content: "b", role: "assistant" }]);
    now = new Date("2026-07-14T09:10:00.000Z");
    await store.appendTurns("c2", [{ content: "c", role: "user" }]);

    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(["c2", "c1"]);
    expect(list.find((s) => s.id === "c1")?.turnCount).toBe(2);
    expect((list[0] as unknown as { turns?: unknown }).turns).toBeUndefined();
  });

  it("rename() persists the new title and bumps updatedAt; delete() removes the conversation durably", async () => {
    const file = tmpFile();
    let now = new Date("2026-07-14T09:00:00.000Z");
    const store = new FileConversationStore({ file, now: () => now });
    await store.appendTurns("c1", [{ content: "hi", role: "user" }]);

    now = new Date("2026-07-14T09:05:00.000Z");
    expect(await store.rename("c1", "renamed title")).toBe(true);
    expect((await store.get("c1"))?.title).toBe("renamed title");
    expect((await store.get("c1"))?.updatedAt).toBe("2026-07-14T09:05:00.000Z");
    expect(await store.rename("does-not-exist", "x")).toBe(false);

    expect(await store.delete("c1")).toBe(true);
    const reopened = new FileConversationStore({ file });
    expect(await reopened.get("c1")).toBeUndefined();
    expect(await reopened.list()).toHaveLength(0);
    expect(await store.delete("c1")).toBe(false);
  });

  it("delete() removes only the targeted conversation — no collateral damage on siblings", async () => {
    const file = tmpFile();
    const store = new FileConversationStore({ file });
    await store.appendTurns("c1", [{ content: "keep me", role: "user" }]);
    await store.appendTurns("c2", [{ content: "drop me", role: "user" }]);

    await store.delete("c2");

    const reopened = new FileConversationStore({ file });
    const list = await reopened.list();
    expect(list.map((s) => s.id)).toEqual(["c1"]);
    expect((await reopened.get("c1"))?.turns.map((t) => t.content)).toEqual(["keep me"]);
  });

  it("replaceTurns() overwrites the whole turn list (used by /reset + compaction rewrite)", async () => {
    const file = tmpFile();
    const store = new FileConversationStore({ file });
    await store.appendTurns("c1", [{ content: "a", role: "user" }, { content: "b", role: "assistant" }]);

    const cleared = await store.replaceTurns("c1", []);
    expect(cleared?.turns).toEqual([]);

    const rewritten = await store.replaceTurns("c1", [{ content: "(summary)", role: "system" }]);
    expect(rewritten?.turns.map((t) => t.content)).toEqual(["(summary)"]);

    expect(await store.replaceTurns("does-not-exist", [])).toBeUndefined();
  });

  it("per-conversation turn cap: keeps FULL turns up to 200, then drops the OLDEST on overflow", async () => {
    const file = tmpFile();
    const store = new FileConversationStore({ file });
    const initial = Array.from({ length: MAX_TURNS_PER_CONVERSATION }, (_, i) => ({ content: `turn-${i.toString()}`, role: "user" as const }));
    await store.appendTurns("c1", initial);

    const overflowed = await store.appendTurns("c1", [{ content: "turn-overflow", role: "user" }]);
    expect(overflowed.turns).toHaveLength(MAX_TURNS_PER_CONVERSATION);
    // The oldest turn (turn-0) was dropped; the newest (overflow) survives.
    expect(overflowed.turns[0]!.content).toBe("turn-1");
    expect(overflowed.turns.at(-1)!.content).toBe("turn-overflow");
  });

  it("writes the file atomically (JSON parses cleanly after appendTurns) and only ONE final file remains", async () => {
    const file = tmpFile();
    const store = new FileConversationStore({ file });
    await store.appendTurns("c1", [{ content: "hi", role: "user" }]);

    const raw = await readFile(file, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const dir = file.slice(0, file.lastIndexOf("/"));
    const siblings = readdirSync(dir).filter((name) => name.startsWith("conversations.json.tmp-"));
    expect(siblings).toEqual([]);
  });

  it("concurrent appendTurns() calls against the SAME file both persist (cross-process lock serializes the RMW)", async () => {
    const file = tmpFile();
    const storeA = new FileConversationStore({ file });
    const storeB = new FileConversationStore({ file });

    await Promise.all([
      storeA.appendTurns("c1", [{ content: "from A", role: "user" }]),
      storeB.appendTurns("c2", [{ content: "from B", role: "user" }])
    ]);

    const reopened = new FileConversationStore({ file });
    const list = await reopened.list();
    expect(list.map((s) => s.id).sort()).toEqual(["c1", "c2"]);
  });

  it("a failed/aborted mutation leaves the store unchanged (a locked write that throws never commits a partial state)", async () => {
    const file = tmpFile();
    const store = new FileConversationStore({ file });
    await store.appendTurns("c1", [{ content: "safe turn", role: "user" }]);
    const before = await readFile(file, "utf8");

    // A mutation whose in-memory step throws (mem.appendTurns never called because
    // the delegate rejects) must not touch the on-disk file at all.
    const failingStore = new FileConversationStore({
      file,
      now: () => { throw new Error("clock exploded"); }
    });
    await expect(failingStore.appendTurns("c2", [{ content: "never persisted", role: "user" }])).rejects.toThrow("clock exploded");

    const after = await readFile(file, "utf8");
    expect(after).toBe(before);
    const reopened = new FileConversationStore({ file });
    expect(await reopened.get("c2")).toBeUndefined();
  });

  it("a corrupt JSON file fails soft to empty and is quarantined (renamed aside), never thrown", async () => {
    const file = tmpFile();
    writeFileSync(file, "{ not valid json", "utf8");

    const store = new FileConversationStore({ file });
    expect(await store.list()).toEqual([]);

    const dir = file.slice(0, file.lastIndexOf("/"));
    const siblings = readdirSync(dir);
    expect(siblings.some((name) => name.startsWith("conversations.json.corrupt-"))).toBe(true);
  });

  it("a JSON file with the wrong shape (no `conversations` map) also fails soft + quarantines", async () => {
    const file = tmpFile();
    writeFileSync(file, `${JSON.stringify({ notConversations: {} })}\n`, "utf8");

    const store = new FileConversationStore({ file });
    expect(await store.list()).toEqual([]);
  });

  it("drops a single malformed conversation entry (missing required field) but keeps the rest", async () => {
    const file = tmpFile();
    const now = new Date().toISOString();
    writeFileSync(file, `${JSON.stringify({
      conversations: {
        c1: { createdAt: now, id: "c1", origin: "cli", title: "good", turns: [], updatedAt: now },
        c2: { id: "c2", title: "missing timestamps" }
      },
      version: 1
    })}\n`, "utf8");

    const store = new FileConversationStore({ file });
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(["c1"]);
  });

  it("drops a single malformed turn (bad role / missing content) but keeps the rest of that conversation's turns", async () => {
    const file = tmpFile();
    const now = new Date().toISOString();
    writeFileSync(file, `${JSON.stringify({
      conversations: {
        c1: {
          createdAt: now, id: "c1", origin: "cli", title: "t", updatedAt: now,
          turns: [
            { content: "good", role: "user" },
            { content: "bad role", role: "narrator" },
            { role: "user" }
          ]
        }
      },
      version: 1
    })}\n`, "utf8");

    const store = new FileConversationStore({ file });
    const found = await store.get("c1");
    expect(found?.turns).toEqual([{ content: "good", role: "user" }]);
  });
});

describe("resolveConversationRef — id-or-prefix resolution (fail-close on ambiguity)", () => {
  const summaries: readonly ConversationSummary[] = [
    { createdAt: "2026-07-01T00:00:00Z", id: "conv_aaaa1111", origin: "cli", title: "one", turnCount: 2, updatedAt: "2026-07-01T00:00:00Z" },
    { createdAt: "2026-07-02T00:00:00Z", id: "conv_aaaa2222", origin: "cli", title: "two", turnCount: 4, updatedAt: "2026-07-02T00:00:00Z" },
    { createdAt: "2026-07-03T00:00:00Z", id: "conv_bbbb3333", origin: "cli", title: "three", turnCount: 1, updatedAt: "2026-07-03T00:00:00Z" }
  ];

  it("resolves an exact id even when it is ALSO a valid prefix of another id", () => {
    const result = resolveConversationRef(summaries, "conv_aaaa1111");
    expect(result).toEqual({ status: "resolved", summary: summaries[0] });
  });

  it("resolves a unique prefix", () => {
    const result = resolveConversationRef(summaries, "conv_bbbb");
    expect(result).toEqual({ status: "resolved", summary: summaries[2] });
  });

  it("returns ambiguous with every candidate when a prefix matches more than one id", () => {
    const result = resolveConversationRef(summaries, "conv_aaaa");
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates.map((c) => c.id).sort()).toEqual(["conv_aaaa1111", "conv_aaaa2222"]);
  });

  it("returns not-found for a ref that matches nothing", () => {
    expect(resolveConversationRef(summaries, "conv_zzzz")).toEqual({ status: "not-found" });
  });

  it("returns not-found for an empty/whitespace ref", () => {
    expect(resolveConversationRef(summaries, "   ")).toEqual({ status: "not-found" });
  });
});
