import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { appendThreadTurns } from "@muse/messaging";
import { FileConversationStore } from "@muse/stores";

import { conversationStoreThreadedTurnStore, migrateLegacyThreadFile, THREADED_CHANNEL_READ_LIMIT } from "../src/threaded-conversation-store.js";

// AC3: Telegram/Matrix live in the shared conversation store — the runner's
// generic ThreadedTurnStore adapter, the legacy-file migration (lossless,
// idempotent, fail-soft on a mid-migration error), and the read-side cap
// staying 12 (the pre-S3b MAX_TURNS raw-turn count, not widened to the
// CLI/web's 24).

function tmpConversationsFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-threaded-conv-")), "conversations.json");
}

describe("conversationStoreThreadedTurnStore — the runner backend", () => {
  it("read/append round-trip through the conversation store under the exact thread key", async () => {
    const store = new FileConversationStore({ file: tmpConversationsFile() });
    const backend = conversationStoreThreadedTurnStore(store, { origin: "telegram" });

    expect(await backend.read("telegram:555")).toEqual([]);
    await backend.append("telegram:555", [
      { content: "remember my name is Sam", role: "user" },
      { content: "Noted, Sam.", role: "assistant" }
    ]);

    expect(await backend.read("telegram:555")).toEqual([
      { content: "remember my name is Sam", role: "user" },
      { content: "Noted, Sam.", role: "assistant" }
    ]);

    const conversation = await store.get("telegram:555");
    expect(conversation?.origin).toBe("telegram");
    // Title derives from the first user message — same as any other conversation.
    expect(conversation?.title).toBe("remember my name is Sam");
  });

  it("caps the read at THREADED_CHANNEL_READ_LIMIT (12) raw turns — unchanged from the pre-S3b MAX_TURNS", async () => {
    expect(THREADED_CHANNEL_READ_LIMIT).toBe(12);
    const store = new FileConversationStore({ file: tmpConversationsFile() });
    const backend = conversationStoreThreadedTurnStore(store, { origin: "telegram" });
    const fifteen = Array.from({ length: 15 }, (_, i) => ({
      content: `t${i.toString()}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant"
    }));
    await backend.append("telegram:555", fifteen);

    const read = await backend.read("telegram:555");
    expect(read).toHaveLength(12);
    expect(read[0]?.content).toBe("t3");
    expect(read[read.length - 1]?.content).toBe("t14");
  });

  it("isolates threads per key — no bleed across channels", async () => {
    const store = new FileConversationStore({ file: tmpConversationsFile() });
    const backend = conversationStoreThreadedTurnStore(store, { origin: "telegram" });
    await backend.append("telegram:c1", [{ content: "hi from c1", role: "user" }]);
    await backend.append("telegram:c2", [{ content: "hi from c2", role: "user" }]);
    expect(await backend.read("telegram:c1")).toEqual([{ content: "hi from c1", role: "user" }]);
    expect(await backend.read("telegram:c2")).toEqual([{ content: "hi from c2", role: "user" }]);
  });

  // S5: slash commands (/new /status /model /help) are control-plane, not
  // conversation content — appending them would pollute the next turn's
  // context and, for /new specifically, immediately re-add a turn to the
  // very conversation it just cleared.
  it("skips persisting a slash-command turn pair (leading '/' in the user turn)", async () => {
    const store = new FileConversationStore({ file: tmpConversationsFile() });
    const backend = conversationStoreThreadedTurnStore(store, { origin: "telegram" });
    await backend.append("telegram:555", [
      { content: "/status", role: "user" },
      { content: "Muse status: model=default...", role: "assistant" }
    ]);
    expect(await backend.read("telegram:555")).toEqual([]);
    expect(await store.get("telegram:555")).toBeUndefined();
  });

  it("a message that merely CONTAINS a slash mid-text is persisted normally (only a leading '/' is control-plane)", async () => {
    const store = new FileConversationStore({ file: tmpConversationsFile() });
    const backend = conversationStoreThreadedTurnStore(store, { origin: "telegram" });
    await backend.append("telegram:555", [
      { content: "what's the a/b test result?", role: "user" },
      { content: "here's the result...", role: "assistant" }
    ]);
    expect(await backend.read("telegram:555")).toEqual([
      { content: "what's the a/b test result?", role: "user" },
      { content: "here's the result...", role: "assistant" }
    ]);
  });
});

describe("migrateLegacyThreadFile — one-time lossless import", () => {
  it("is a no-op when the legacy file never existed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-migrate-"));
    const threadFile = join(dir, "telegram-inbox.json.threads.json");
    const store = new FileConversationStore({ file: join(dir, "conversations.json") });

    const result = await migrateLegacyThreadFile(threadFile, store, { origin: "telegram" });
    expect(result).toEqual({ migrated: false, threadCount: 0 });
  });

  it("imports every thread, renames the legacy file aside, and is idempotent on a second call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-migrate-"));
    const threadFile = join(dir, "telegram-inbox.json.threads.json");
    await appendThreadTurns(threadFile, "telegram:555", [
      { content: "hi from legacy", role: "user" },
      { content: "hello!", role: "assistant" }
    ]);
    await appendThreadTurns(threadFile, "telegram:777", [{ content: "another thread", role: "user" }]);
    const store = new FileConversationStore({ file: join(dir, "conversations.json") });

    const first = await migrateLegacyThreadFile(threadFile, store, { origin: "telegram" });
    expect(first).toEqual({ migrated: true, threadCount: 2 });

    // Legacy file renamed aside, never deleted.
    await expect(access(threadFile)).rejects.toBeTruthy();
    await expect(access(`${threadFile}.migrated`)).resolves.toBeUndefined();

    const migratedConversation = await store.get("telegram:555");
    expect(migratedConversation?.turns.map((t) => t.content)).toEqual(["hi from legacy", "hello!"]);
    expect(migratedConversation?.origin).toBe("telegram");

    // Idempotent: a second call finds no legacy file (already renamed) and does nothing.
    const second = await migrateLegacyThreadFile(threadFile, store, { origin: "telegram" });
    expect(second).toEqual({ migrated: false, threadCount: 0 });
    const stillOneCopy = await store.get("telegram:555");
    expect(stillOneCopy?.turns).toHaveLength(2);
  });

  it("a mid-migration append failure leaves the legacy file intact (never a partial import)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-migrate-"));
    const threadFile = join(dir, "telegram-inbox.json.threads.json");
    await appendThreadTurns(threadFile, "telegram:555", [{ content: "hi", role: "user" }]);
    const failingStore = {
      appendTurns: async () => {
        throw new Error("disk full");
      }
    } as unknown as FileConversationStore;

    const result = await migrateLegacyThreadFile(threadFile, failingStore, { origin: "telegram" });
    expect(result).toEqual({ migrated: false, threadCount: 0 });

    // The legacy file is untouched — a retry on the next boot has real data to work with.
    await expect(access(threadFile)).resolves.toBeUndefined();
    const raw = readFileSync(threadFile, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ threads: { "telegram:555": [{ content: "hi", role: "user" }] } });
  });

  it("a malformed legacy file still gets renamed aside — nothing recoverable, so no repeated migration attempts on every boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-migrate-"));
    const threadFile = join(dir, "telegram-inbox.json.threads.json");
    writeFileSync(threadFile, "not json");
    const store = new FileConversationStore({ file: join(dir, "conversations.json") });

    const result = await migrateLegacyThreadFile(threadFile, store, { origin: "telegram" });
    expect(result).toEqual({ migrated: true, threadCount: 0 });
    await expect(access(threadFile)).rejects.toBeTruthy();
    await expect(access(`${threadFile}.migrated`)).resolves.toBeUndefined();
  });
});
