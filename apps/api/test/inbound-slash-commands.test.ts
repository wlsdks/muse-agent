import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordPendingApproval } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { handleInboundSlashCommand, type SlashConversationStore } from "../src/inbound-slash-commands.js";

// S5: in-channel slash commands (/new /status /model /help) — deterministic,
// the model is never consulted. Covers each command's happy path plus the
// AC3 safety invariants that are this module's own responsibility (unknown
// command, empty/nonexistent conversation, per-chat isolation).

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "muse-slash-")), name);
}

function fakeStore(seed: Record<string, readonly unknown[]> = {}): {
  readonly store: SlashConversationStore;
  readonly cleared: string[];
} {
  const data = new Map<string, readonly unknown[]>(Object.entries(seed));
  const cleared: string[] = [];
  const store: SlashConversationStore = {
    get: async (id) => {
      const turns = data.get(id);
      return turns ? { turns } : undefined;
    },
    replaceTurns: async (id, turns) => {
      data.set(id, turns);
      cleared.push(id);
      return { turns };
    }
  };
  return { cleared, store };
}

describe("handleInboundSlashCommand — non-slash text", () => {
  it("returns undefined for plain text (falls through to the normal chain)", async () => {
    const reply = await handleInboundSlashCommand({
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "hey how are you"
    });
    expect(reply).toBeUndefined();
  });

  it("a slash MID-TEXT (not leading) is NOT intercepted", async () => {
    const reply = await handleInboundSlashCommand({
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "check out a/b testing"
    });
    expect(reply).toBeUndefined();
  });

  it("leading whitespace before the slash still counts as a command", async () => {
    const reply = await handleInboundSlashCommand({
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "   /help"
    });
    expect(reply).toContain("/new");
  });
});

describe("handleInboundSlashCommand — /help and unknown commands", () => {
  it("/help lists every command", async () => {
    const reply = await handleInboundSlashCommand({
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/help"
    });
    expect(reply).toContain("/new");
    expect(reply).toContain("/status");
    expect(reply).toContain("/model");
    expect(reply).toContain("/help");
  });

  it("/start (Telegram's bot-open auto-command) gets the same reply as /help", async () => {
    const help = await handleInboundSlashCommand({
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/help"
    });
    const start = await handleInboundSlashCommand({
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/start"
    });
    expect(start).toBe(help);
  });

  it("an unknown command (/foo) gets a help-text reply, never a crash", async () => {
    const reply = await handleInboundSlashCommand({
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/foo bar"
    });
    expect(reply).toContain("/foo");
    expect(reply).toContain("/help");
  });

  it("strips a Telegram group @botname suffix (/status@my_bot)", async () => {
    const reply = await handleInboundSlashCommand({
      model: "gemma4:12b",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "-100999",
      text: "/model@jinan_muse_bot"
    });
    expect(reply).toContain("gemma4:12b");
  });
});

describe("handleInboundSlashCommand — /model", () => {
  it("shows the resolved default model id and notes switching isn't supported yet", async () => {
    const reply = await handleInboundSlashCommand({
      model: "gemma4:12b",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/model"
    });
    expect(reply).toContain("gemma4:12b");
    expect(reply?.toLowerCase()).toContain("not yet");
  });
});

describe("handleInboundSlashCommand — /status", () => {
  it("reports the model, pending-approval count for THIS chat, and stored turn count", async () => {
    const pendingFile = tmpFile("pending.json");
    const now = new Date();
    await recordPendingApproval(pendingFile, {
      arguments: {},
      createdAt: now.toISOString(),
      draft: "book flight",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      id: "p1",
      providerId: "telegram",
      risk: "execute",
      source: "42",
      tool: "web_action"
    });
    const { store } = fakeStore({ "telegram:42": [{ role: "user" }, { role: "assistant" }] });
    const reply = await handleInboundSlashCommand({
      conversationStore: store,
      model: "default",
      pendingApprovalsFile: pendingFile,
      providerId: "telegram",
      source: "42",
      text: "/status"
    });
    expect(reply).toContain("model=default");
    expect(reply).toContain("pending approvals=1");
    expect(reply).toContain("turns=2");
  });

  it("a DIFFERENT chat's pending approval / conversation never leaks into this chat's /status", async () => {
    const pendingFile = tmpFile("pending.json");
    const now = new Date();
    await recordPendingApproval(pendingFile, {
      arguments: {},
      createdAt: now.toISOString(),
      draft: "book flight",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      id: "p1",
      providerId: "telegram",
      risk: "execute",
      source: "999",
      tool: "web_action"
    });
    const { store } = fakeStore({ "telegram:999": [{ role: "user" }, { role: "assistant" }, { role: "user" }] });
    const reply = await handleInboundSlashCommand({
      conversationStore: store,
      model: "default",
      pendingApprovalsFile: pendingFile,
      providerId: "telegram",
      source: "42",
      text: "/status"
    });
    expect(reply).toContain("pending approvals=0");
    expect(reply).toContain("turns=0");
  });

  it("degrades to turns=0 when no conversationStore is wired (never throws)", async () => {
    const reply = await handleInboundSlashCommand({
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/status"
    });
    expect(reply).toContain("turns=0");
  });
});

describe("handleInboundSlashCommand — /new", () => {
  it("clears THIS chat's conversation and confirms", async () => {
    const { cleared, store } = fakeStore({ "telegram:42": [{ role: "user" }, { role: "assistant" }] });
    const reply = await handleInboundSlashCommand({
      conversationStore: store,
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/new"
    });
    expect(reply?.toLowerCase()).toMatch(/fresh|cleared/);
    expect(cleared).toEqual(["telegram:42"]);
    await expect(store.get("telegram:42")).resolves.toEqual({ turns: [] });
  });

  it("a nonexistent conversation gets a friendly no-op reply, no crash", async () => {
    const { cleared, store } = fakeStore();
    const reply = await handleInboundSlashCommand({
      conversationStore: store,
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/new"
    });
    expect(reply?.toLowerCase()).toMatch(/already empty|nothing to clear/);
    expect(cleared).toEqual([]);
  });

  it("an already-empty conversation gets the same friendly no-op (no needless write)", async () => {
    const { cleared, store } = fakeStore({ "telegram:42": [] });
    const reply = await handleInboundSlashCommand({
      conversationStore: store,
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/new"
    });
    expect(reply?.toLowerCase()).toMatch(/already empty|nothing to clear/);
    expect(cleared).toEqual([]);
  });

  it("clears ONLY this chat's conversation — a sibling conversation is untouched (collateral test)", async () => {
    const { cleared, store } = fakeStore({
      "telegram:42": [{ role: "user" }],
      "telegram:999": [{ role: "user" }, { role: "assistant" }]
    });
    await handleInboundSlashCommand({
      conversationStore: store,
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/new"
    });
    expect(cleared).toEqual(["telegram:42"]);
    await expect(store.get("telegram:999")).resolves.toEqual({
      turns: [{ role: "user" }, { role: "assistant" }]
    });
  });

  it("degrades to a safe 'not available' reply when no conversationStore is wired (never throws)", async () => {
    const reply = await handleInboundSlashCommand({
      model: "default",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/new"
    });
    expect(reply?.toLowerCase()).toContain("isn't available");
  });
});
