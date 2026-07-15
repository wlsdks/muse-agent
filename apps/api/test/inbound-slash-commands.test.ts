import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

describe("handleInboundSlashCommand — /model (bare, show-only)", () => {
  it("shows the resolved default model id and how to switch", async () => {
    const reply = await handleInboundSlashCommand({
      model: "gemma4:12b",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/model"
    });
    expect(reply).toContain("gemma4:12b");
    expect(reply).toContain("/model <name>");
  });
});

// R3-3: `/model <name>` switches the default model, validated against what
// Ollama actually has installed — the SAME implementation `muse model use`
// (apps/cli) calls, through `@muse/autoconfigure`'s model-registry. Every
// fetch below is INJECTED (house rule: a vitest run never touches the
// network) and every write goes through an isolated tmp `configFilePath`.
describe("handleInboundSlashCommand — /model <name> (R3-3 switch)", () => {
  function tmpConfigFile(): string {
    return join(mkdtempSync(join(tmpdir(), "muse-slash-model-")), "config.json");
  }

  function fakeTagsFetch(names: readonly string[]): typeof globalThis.fetch {
    return (async () => new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 })) as unknown as typeof globalThis.fetch;
  }

  function unreachableFetch(): typeof globalThis.fetch {
    return (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof globalThis.fetch;
  }

  function neverCalledFetch(): typeof globalThis.fetch {
    return (async () => { throw new Error("fetch must not be called on this path"); }) as unknown as typeof globalThis.fetch;
  }

  it("an installed model → confirms old → new and writes the config file", async () => {
    const configFilePath = tmpConfigFile();
    const reply = await handleInboundSlashCommand({
      configFilePath,
      env: {},
      fetchImpl: fakeTagsFetch(["gemma4:12b", "qwen3:8b"]),
      model: "gemma4:12b",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/model qwen3:8b"
    });
    expect(reply).toContain("gemma4:12b → ollama/qwen3:8b");
    const written = JSON.parse(readFileSync(configFilePath, "utf8")) as { defaultModel?: string };
    expect(written.defaultModel).toBe("ollama/qwen3:8b");
  });

  it("strips the Telegram @botname suffix on /model AND still parses the trailing model argument", async () => {
    const configFilePath = tmpConfigFile();
    const reply = await handleInboundSlashCommand({
      configFilePath,
      env: {},
      fetchImpl: fakeTagsFetch(["qwen3:8b"]),
      model: "gemma4:12b",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "-100999",
      text: "/model@jinan_muse_bot qwen3:8b"
    });
    expect(reply).toContain("→ ollama/qwen3:8b");
  });

  it("Ollama unreachable → no config write, actionable reply", async () => {
    const configFilePath = tmpConfigFile();
    const reply = await handleInboundSlashCommand({
      configFilePath,
      env: {},
      fetchImpl: unreachableFetch(),
      model: "gemma4:12b",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/model qwen3:8b"
    });
    expect(reply?.toLowerCase()).toContain("not reachable");
    expect(existsSync(configFilePath)).toBe(false);
  });

  it("unknown/misspelled model → no config write, close-miss suggestion, capped installed list", async () => {
    const configFilePath = tmpConfigFile();
    const reply = await handleInboundSlashCommand({
      configFilePath,
      env: {},
      fetchImpl: fakeTagsFetch(["gemma4:12b"]),
      model: "gemma4:12b",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/model gemma4:12"
    });
    expect(reply).toContain("Did you mean 'gemma4:12b'?");
    expect(existsSync(configFilePath)).toBe(false);
  });

  it("MUSE_LOCAL_ONLY + a cloud model spec → refused BEFORE any network call, no config write", async () => {
    const configFilePath = tmpConfigFile();
    const reply = await handleInboundSlashCommand({
      configFilePath,
      env: { MUSE_LOCAL_ONLY: "true" },
      fetchImpl: neverCalledFetch(),
      model: "gemma4:12b",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/model gemini/gemini-2.0-flash"
    });
    expect(reply).toContain("Refused");
    expect(reply).toContain("MUSE_LOCAL_ONLY");
    expect(existsSync(configFilePath)).toBe(false);
  });

  it("an active MUSE_MODEL env override → the switch still writes config, reply says the env var currently wins", async () => {
    const configFilePath = tmpConfigFile();
    const reply = await handleInboundSlashCommand({
      configFilePath,
      env: { MUSE_MODEL: "ollama/gemma4:12b" },
      fetchImpl: fakeTagsFetch(["qwen3:8b"]),
      model: "gemma4:12b",
      pendingApprovalsFile: tmpFile("pending.json"),
      providerId: "telegram",
      source: "42",
      text: "/model qwen3:8b"
    });
    expect(reply).toContain("MUSE_MODEL=ollama/gemma4:12b is set");
    const written = JSON.parse(readFileSync(configFilePath, "utf8")) as { defaultModel?: string };
    expect(written.defaultModel).toBe("ollama/qwen3:8b");
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
