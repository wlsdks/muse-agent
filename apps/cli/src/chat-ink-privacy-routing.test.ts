import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";

import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";

import { createChatCloudTurn } from "./chat-repl.js";
import { MuseChatApp } from "./chat-ink.js";

// --- createChatCloudTurn: the seam chat-ink-run.ts wires into the interactive
// Ink chat, mirroring runLocalChat's inline cloud leg — the env is a plain
// object param here (no process.env mutation needed). ---

function fakeCloudProvider(output: string): { generate: ReturnType<typeof vi.fn>; provider: ModelProvider } {
  const generate = vi.fn(async (request: ModelRequest) => ({ id: "cloud-run", model: request.model, output } as ModelResponse));
  return {
    generate,
    provider: {
      generate,
      id: "gemini",
      listModels: async () => [],
      stream: (async function* () { /* unused */ })()
    } as unknown as ModelProvider
  };
}

const ROUTING_ON_ENV = { MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" };

describe("createChatCloudTurn", () => {
  it("routing off (empty env) → undefined, factory never called", async () => {
    const factory = vi.fn();
    const cloudTurn = createChatCloudTurn({
      cloudProviderFactory: factory,
      defaultModel: "ollama/gemma4:12b",
      env: {},
      memoryFacts: () => undefined
    });
    const result = await cloudTurn("translate hello to french", "", "");
    expect(result).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("MUSE_LOCAL_ONLY=true wins even with routing on → undefined, factory never called", async () => {
    const factory = vi.fn();
    const cloudTurn = createChatCloudTurn({
      cloudProviderFactory: factory,
      defaultModel: "ollama/gemma4:12b",
      env: { ...ROUTING_ON_ENV, MUSE_LOCAL_ONLY: "true" },
      memoryFacts: () => undefined
    });
    const result = await cloudTurn("translate hello to french", "", "");
    expect(result).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("routing on + a persona block was built → undefined (personal)", async () => {
    const factory = vi.fn();
    const cloudTurn = createChatCloudTurn({
      cloudProviderFactory: factory,
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      memoryFacts: () => undefined
    });
    const result = await cloudTurn("translate hello to french", "Name: Jinan", "");
    expect(result).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("routing on + a grounding block was built → undefined (personal)", async () => {
    const factory = vi.fn();
    const cloudTurn = createChatCloudTurn({
      cloudProviderFactory: factory,
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      memoryFacts: () => undefined
    });
    const result = await cloudTurn("translate hello to french", "", "\n\nThe following passages are from the user's OWN notes…");
    expect(result).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("routing on + a possessive-marker query → undefined (personal)", async () => {
    const factory = vi.fn();
    const cloudTurn = createChatCloudTurn({
      cloudProviderFactory: factory,
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      memoryFacts: () => undefined
    });
    const result = await cloudTurn("what's my name?", "", "");
    expect(result).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("routing on + a query referencing a remembered fact BY VALUE → undefined (personal)", async () => {
    const factory = vi.fn();
    const cloudTurn = createChatCloudTurn({
      cloudProviderFactory: factory,
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      memoryFacts: () => ({ doctor: "Dr. Kim" })
    });
    const result = await cloudTurn("Dr. Kim 예약 언제야", "", "");
    expect(result).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("routing on + a context-free query → defined, exactly 2 messages, no persona/grounding text, marker names the model", async () => {
    const { generate, provider } = fakeCloudProvider("Bonjour le monde");
    const factory = vi.fn(() => provider);
    const cloudTurn = createChatCloudTurn({
      cloudProviderFactory: factory,
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      memoryFacts: () => undefined
    });
    const result = await cloudTurn("translate hello to french", "", "");
    expect(result).toBeDefined();
    expect(factory).toHaveBeenCalledWith("gemini/gemini-2.5-flash", expect.anything());
    expect(generate).toHaveBeenCalledTimes(1);
    const sent = generate.mock.calls[0]?.[0] as ModelRequest;
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages.map((m) => m.content).join("\n")).not.toContain("OWN notes");
    expect(sent.messages[1]).toEqual({ content: "translate hello to french", role: "user" });
    expect(result?.marker).toContain("gemini/gemini-2.5-flash");
  });

  it("factory returns undefined → undefined (falls back to local)", async () => {
    const cloudTurn = createChatCloudTurn({
      cloudProviderFactory: () => undefined,
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      memoryFacts: () => undefined
    });
    const result = await cloudTurn("translate hello to french", "", "");
    expect(result).toBeUndefined();
  });

  it("generate() throwing → undefined (falls back to local, never surfaces an error)", async () => {
    const throwingProvider = { generate: async () => { throw new Error("network down"); }, id: "gemini", listModels: async () => [] } as unknown as ModelProvider;
    const cloudTurn = createChatCloudTurn({
      cloudProviderFactory: () => throwingProvider,
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      memoryFacts: () => undefined
    });
    const result = await cloudTurn("translate hello to french", "", "");
    expect(result).toBeUndefined();
  });

  it("an empty completion → undefined (falls back to local)", async () => {
    const { provider } = fakeCloudProvider("   ");
    const cloudTurn = createChatCloudTurn({
      cloudProviderFactory: () => provider,
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      memoryFacts: () => undefined
    });
    const result = await cloudTurn("translate hello to french", "", "");
    expect(result).toBeUndefined();
  });
});

// --- Component wiring: MuseChatApp's `cloudTurn` prop actually short-circuits
// the stream when eligible, and defers to it otherwise (parity/fallback). ---

async function* empty(): AsyncGenerator<{ type: string }> { /* no events */ }

function makeProps(overrides: Record<string, unknown> = {}): Parameters<typeof MuseChatApp>[0] {
  return {
    banner: "MUSE",
    history: [],
    agents: [],
    model: "ollama/gemma4:12b",
    models: ["ollama/gemma4:12b"],
    proactiveOn: false,
    localOnly: true,
    skills: [],
    skillsDir: "/tmp/skills",
    skillsPromptFor: () => "",
    personaPrompt: () => undefined,
    stream: () => empty(),
    streamWithTools: () => empty(),
    readFile: async () => undefined,
    saveText: async () => undefined,
    copyToClipboard: async () => false,
    onCommit: () => undefined,
    onReset: () => undefined,
    memorySnapshot: async () => undefined,
    forgetMemory: async () => true,
    rememberFact: async () => true,
    setPreference: async () => true,
    wipeMemory: async () => true,
    trustInfo: async () => ({ trusted: [], blocked: [] }),
    recallSearch: async () => "no hits",
    todayBrief: async () => "Today (next 24h)\nTasks: (none open)",
    startJob: () => "job_test",
    jobsOverview: async () => [],
    recap: "",
    ...overrides
  } as Parameters<typeof MuseChatApp>[0];
}

const tick = (ms = 60): Promise<void> => sleep(ms);

async function waitForFrame(
  lastFrame: () => string | undefined,
  needles: readonly string[],
  timeoutMs = 2000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = lastFrame() ?? "";
  while (Date.now() < deadline && !needles.every((needle) => frame.includes(needle))) {
    await sleep(20);
    frame = lastFrame() ?? "";
  }
  return frame;
}

describe("MuseChatApp — cloudTurn prop wiring", () => {
  it("a resolved cloudTurn short-circuits the stream: display carries the marker, persisted history does not, stream is never invoked", async () => {
    const cloudTurn = vi.fn(async () => ({ marker: "\n\n☁️ cloud (context-free) — m", text: "Bonjour" }));
    const stream = vi.fn(() => empty());
    let committed = "";
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      cloudTurn,
      onCommit: (_q: string, answer: string) => { committed = answer; },
      stream
    })));
    await tick();
    stdin.write("translate hello to french"); await tick(); stdin.write("\r");
    const frame = await waitForFrame(lastFrame, ["Bonjour", "☁️ cloud (context-free) — m"]);
    unmount();
    expect(frame).toContain("Bonjour");
    expect(frame).toContain("☁️ cloud (context-free) — m");
    expect(committed).toContain("Bonjour");
    expect(committed).not.toContain("☁️");
    expect(stream).not.toHaveBeenCalled();
    expect(cloudTurn).toHaveBeenCalledTimes(1);
  });

  it("cloudTurn resolving undefined falls back to the local stream", async () => {
    async function* reply(): AsyncGenerator<{ type: string; text?: string }> {
      yield { text: "Bonjour (local).", type: "text-delta" };
      yield { type: "done" };
    }
    const cloudTurn = vi.fn(async () => undefined);
    const stream = vi.fn(() => reply());
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({ cloudTurn, stream })));
    await tick();
    stdin.write("translate hello to french"); await tick(); stdin.write("\r");
    const frame = await waitForFrame(lastFrame, ["Bonjour (local)."]);
    unmount();
    expect(frame).toContain("Bonjour (local).");
    expect(stream).toHaveBeenCalledTimes(1);
    expect(cloudTurn).toHaveBeenCalledTimes(1);
  });

  it("a turn with an @file attachment stays local — cloudTurn is never invoked", async () => {
    async function* reply(): AsyncGenerator<{ type: string; text?: string }> {
      yield { text: "read the file.", type: "text-delta" };
      yield { type: "done" };
    }
    const cloudTurn = vi.fn(async () => ({ marker: "", text: "should not be used" }));
    const stream = vi.fn(() => reply());
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      cloudTurn,
      readFile: async () => "file contents",
      stream
    })));
    await tick();
    stdin.write("@notes.md summarize this"); await tick(); stdin.write("\r");
    const frame = await waitForFrame(lastFrame, ["read the file."]);
    unmount();
    expect(frame).toContain("read the file.");
    expect(cloudTurn).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
