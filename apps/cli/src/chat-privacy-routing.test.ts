import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "@muse/agent-core";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";

import {
  buildCloudTurnRequest,
  chatHasPersonalContext,
  formatCloudRouteMarker,
  resolveChatRouting,
  runLocalChat
} from "./chat-repl.js";
import type { ProgramIO } from "./program.js";

// --- Pure-unit coverage: the classification + request-shaping logic that
// decides + enforces "a cloud-routed turn carries no persona/grounding/history". ---

describe("chatHasPersonalContext", () => {
  it("false when neither a persona block nor a grounding block was built", () => {
    expect(chatHasPersonalContext("", "")).toBe(false);
  });
  it("true when a persona block was built", () => {
    expect(chatHasPersonalContext("Name: Jinan", "")).toBe(true);
  });
  it("true when a grounding block matched notes", () => {
    expect(chatHasPersonalContext("", "\n\nThe following passages are from the user's OWN notes…")).toBe(true);
  });
});

describe("resolveChatRouting — off by default, cloud only when ON + context-free", () => {
  it("stays local with routing off (byte-identical default posture)", () => {
    const routing = resolveChatRouting({
      defaultModel: "ollama/gemma4:12b",
      env: {},
      groundingBlock: "",
      message: "translate hello to french",
      userMemoryBlock: ""
    });
    expect(routing.route).toBe("local");
  });

  it("routes to the cloud model when routing is on, the query is context-free, and no persona/grounding was built", () => {
    const routing = resolveChatRouting({
      defaultModel: "ollama/gemma4:12b",
      env: { MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" },
      groundingBlock: "",
      message: "translate hello to french",
      userMemoryBlock: ""
    });
    expect(routing).toEqual({
      model: "gemini/gemini-2.5-flash",
      reason: expect.stringContaining("context-free") as unknown as string,
      route: "cloud"
    });
  });

  it("stays local when a persona block was built, even with routing fully on", () => {
    const routing = resolveChatRouting({
      defaultModel: "ollama/gemma4:12b",
      env: { MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" },
      groundingBlock: "",
      message: "translate hello to french",
      userMemoryBlock: "Name: Jinan"
    });
    expect(routing.route).toBe("local");
  });

  it("stays local when a grounding block was built, even with routing fully on", () => {
    const routing = resolveChatRouting({
      defaultModel: "ollama/gemma4:12b",
      env: { MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" },
      groundingBlock: "\n\nThe following passages are from the user's OWN notes…",
      message: "translate hello to french",
      userMemoryBlock: ""
    });
    expect(routing.route).toBe("local");
  });

  it("stays local on a possessive-marker query, even with routing fully on and no persona/grounding built", () => {
    const routing = resolveChatRouting({
      defaultModel: "ollama/gemma4:12b",
      env: { MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" },
      groundingBlock: "",
      message: "what's my name?",
      userMemoryBlock: ""
    });
    expect(routing.route).toBe("local");
  });

  it("stays local on a query referencing a remembered fact BY VALUE", () => {
    const routing = resolveChatRouting({
      defaultModel: "ollama/gemma4:12b",
      env: { MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" },
      groundingBlock: "",
      memoryFacts: { doctor: "Dr. Kim" },
      message: "Dr. Kim 예약 언제야",
      userMemoryBlock: ""
    });
    expect(routing.route).toBe("local");
  });

  it("MUSE_LOCAL_ONLY wins even with routing on and a context-free query", () => {
    const routing = resolveChatRouting({
      defaultModel: "ollama/gemma4:12b",
      env: { MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_LOCAL_ONLY: "true", MUSE_PRIVACY_ROUTING: "true" },
      groundingBlock: "",
      message: "translate hello to french",
      userMemoryBlock: ""
    });
    expect(routing.route).toBe("local");
  });
});

// RED→GREEN — this is the leak-direction proof: `buildCloudTurnRequest` has NO
// parameter for persona text, grounding evidence, or prior turns, so it is
// structurally impossible for it to forward them, however this function is
// wired in. (Before this slice, neither the function nor this test existed —
// the import below is what turned RED the moment it was written, GREEN once
// the export landed.)
describe("buildCloudTurnRequest — structurally cannot carry persona/grounding/history", () => {
  it("sends exactly two messages: a non-personal system line + the raw user message", () => {
    const request = buildCloudTurnRequest("translate hello to french", "gemini/gemini-2.5-flash", {}, new Date("2026-07-10T09:00:00Z"));
    expect(request.model).toBe("gemini/gemini-2.5-flash");
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[1]).toEqual({ content: "translate hello to french", role: "user" });
  });

  it("the system line names no persona fact / grounding preamble — only the reply-language directive + current-context line", () => {
    const request = buildCloudTurnRequest("what time is it", "gemini/gemini-2.5-flash");
    const system = request.messages[0]?.content ?? "";
    expect(system).not.toContain("OWN notes");
    expect(system).toContain("Current local context:");
  });

  it("a Korean message gets the Korean reply-language directive, an English one gets none", () => {
    const ko = buildCloudTurnRequest("오늘 날씨 어때", "gemini/gemini-2.5-flash");
    const en = buildCloudTurnRequest("what's the weather", "gemini/gemini-2.5-flash");
    expect(ko.messages[0]?.content).toContain("한국어");
    expect(en.messages[0]?.content).not.toContain("한국어");
  });
});

describe("formatCloudRouteMarker", () => {
  it("names the model and is language-matched", () => {
    expect(formatCloudRouteMarker(false, "gemini/gemini-2.5-flash")).toContain("gemini/gemini-2.5-flash");
    expect(formatCloudRouteMarker(false, "gemini/gemini-2.5-flash")).toContain("cloud");
    expect(formatCloudRouteMarker(true, "gemini/gemini-2.5-flash")).toContain("클라우드");
  });
});

// --- Integration: runLocalChat actually wires the routing decision. ---

function fakeAgentRuntime(runId: string, output: string): { run: ReturnType<typeof vi.fn>; runtime: AgentRuntime } {
  const run = vi.fn(async () => ({ response: { id: runId, model: "ollama/gemma4:12b", output } as ModelResponse, runId, toolsUsed: [] as readonly string[] }));
  return { run, runtime: { run } as unknown as AgentRuntime };
}

function fakeCloudProvider(output: string): { generate: ReturnType<typeof vi.fn>; provider: ModelProvider } {
  const generate = vi.fn(async (request: ModelRequest) =>
    ({ id: "cloud-run", model: request.model, output } as ModelResponse));
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

function makeIo(dir: string, agentRuntime: AgentRuntime): ProgramIO {
  return {
    createRuntimeAssembly: () => ({ agentRuntime, defaultModel: "ollama/gemma4:12b" }),
    readPipedStdin: async () => "",
    stderr: () => undefined,
    stdout: () => undefined,
    workspaceDir: dir
  };
}

describe("runLocalChat — privacy-tiered routing end to end", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["MUSE_PRIVACY_ROUTING", "MUSE_CLOUD_MODEL", "MUSE_LOCAL_ONLY", "MUSE_CHAT_GROUNDING", "MUSE_WEAKNESSES_FILE", "MUSE_MODEL", "MUSE_MODEL_PROVIDER_ID"] as const;
  const withEnv = async (overrides: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      const dir = mkdtempSync(join(tmpdir(), "muse-chat-privacy-"));
      process.env.MUSE_WEAKNESSES_FILE = join(dir, "weaknesses.json");
      process.env.MUSE_CHAT_GROUNDING = "0"; // no live Ollama retrieval in this test
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await run();
    } finally {
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }
  };

  it("default posture (no env set): local, byte-identical — the local agent runtime is called, no cloud marker", async () => {
    await withEnv({}, async () => {
      const dir = mkdtempSync(join(tmpdir(), "muse-chat-privacy-io-"));
      const { run, runtime } = fakeAgentRuntime("local-1", "Bonjour");
      const io = makeIo(dir, runtime);
      const result = await runLocalChat(io, "translate hello to french", "ollama/gemma4:12b");
      expect(run).toHaveBeenCalledTimes(1);
      expect(result.response).not.toContain("☁️");
    });
  });

  it("routing ON + a possessive-marker (personal) turn → stays local, no marker, local runtime called", async () => {
    await withEnv({ MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "muse-chat-privacy-io-"));
      const { run, runtime } = fakeAgentRuntime("local-2", "Your name is Jinan.");
      const { generate } = fakeCloudProvider("unused");
      const io = makeIo(dir, runtime);
      const result = await runLocalChat(io, "what's my name?", "ollama/gemma4:12b", undefined, {
        cloudProviderFactory: () => { throw new Error("must not be called for a personal turn"); }
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(generate).not.toHaveBeenCalled();
      expect(result.response).not.toContain("☁️");
    });
  });

  it("routing ON + a context-free turn → cloud model used, NO persona/grounding/history in the outbound request, marker shown; local runtime never called", async () => {
    await withEnv({ MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "muse-chat-privacy-io-"));
      const { run, runtime } = fakeAgentRuntime("local-3", "should not be used");
      const { generate, provider } = fakeCloudProvider("Bonjour le monde");
      const io = makeIo(dir, runtime);
      const cloudProviderFactory = vi.fn(() => provider);
      const result = await runLocalChat(io, "translate hello to french", "ollama/gemma4:12b", undefined, {
        cloudProviderFactory,
        priorHistory: [{ content: "my SSN is 123-45-6789", role: "user" }]
      });

      expect(run).not.toHaveBeenCalled(); // the local agent runtime never ran this turn
      expect(cloudProviderFactory).toHaveBeenCalledWith("gemini/gemini-2.5-flash", expect.anything());
      expect(generate).toHaveBeenCalledTimes(1);

      const sentRequest = generate.mock.calls[0]?.[0] as ModelRequest;
      expect(sentRequest.messages).toHaveLength(2); // no prior history forwarded
      expect(sentRequest.messages.map((m) => m.content).join("\n")).not.toContain("123-45-6789");
      expect(sentRequest.messages.map((m) => m.content).join("\n")).not.toContain("OWN notes");
      expect(sentRequest.messages[1]?.content).toBe("translate hello to french");

      expect(result.response).toContain("☁️ cloud (context-free) — gemini/gemini-2.5-flash");
      expect("responseForHistory" in result && result.responseForHistory).toBeTruthy();
      if ("responseForHistory" in result) {
        expect(result.responseForHistory).not.toContain("☁️"); // display-only, never persisted
      }
    });
  });

  it("routing ON + MUSE_LOCAL_ONLY=true → local always; the cloud provider factory is never even attempted", async () => {
    await withEnv({ MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_LOCAL_ONLY: "true", MUSE_PRIVACY_ROUTING: "true" }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "muse-chat-privacy-io-"));
      const { run, runtime } = fakeAgentRuntime("local-4", "Bonjour (local, forced)");
      const io = makeIo(dir, runtime);
      const cloudProviderFactory = vi.fn(() => { throw new Error("must never be called under MUSE_LOCAL_ONLY"); });
      const result = await runLocalChat(io, "translate hello to french", "ollama/gemma4:12b", undefined, { cloudProviderFactory });
      expect(cloudProviderFactory).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(1);
      expect(result.response).not.toContain("☁️");
    });
  });

  it("cloud provider construction failure (no key) → falls back to local, never a user-facing error", async () => {
    await withEnv({ MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "muse-chat-privacy-io-"));
      const { run, runtime } = fakeAgentRuntime("local-5", "Bonjour (fallback)");
      const io = makeIo(dir, runtime);
      const cloudProviderFactory = vi.fn(() => undefined);
      const result = await runLocalChat(io, "translate hello to french", "ollama/gemma4:12b", undefined, { cloudProviderFactory });
      expect(cloudProviderFactory).toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(1); // fell back to the local path
      expect(result.response).not.toContain("☁️");
    });
  });

  it("cloud provider generate() throwing (network down) → falls back to local, never a user-facing error", async () => {
    await withEnv({ MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "muse-chat-privacy-io-"));
      const { run, runtime } = fakeAgentRuntime("local-6", "Bonjour (fallback 2)");
      const io = makeIo(dir, runtime);
      const throwingProvider = { generate: async () => { throw new Error("network down"); }, id: "gemini", listModels: async () => [] } as unknown as ModelProvider;
      const result = await runLocalChat(io, "translate hello to french", "ollama/gemma4:12b", undefined, {
        cloudProviderFactory: () => throwingProvider
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(result.response).not.toContain("☁️");
    });
  });
});
