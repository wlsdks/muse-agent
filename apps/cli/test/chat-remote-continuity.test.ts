import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProgram } from "../src/program.js";

// AC4: remote `muse chat` continuity — sends the ACTIVE conversation id
// (from the S3a pointer) when --continue/--resume asks for it, stays a
// stateless one-off otherwise, and always adopts the server's returned
// conversationId as the new active pointer (so even a one-off becomes
// resumable). --local is untouched throughout.

function captureOutput() {
  const output: string[] = [];
  return {
    io: {
      readPipedStdin: async () => "",
      stderr: (message: string) => output.push(message),
      stdout: (message: string) => output.push(message)
    },
    output
  };
}

describe("muse chat (remote) — conversation continuity", () => {
  let homeEnvBackup: string | undefined;
  beforeEach(async () => {
    homeEnvBackup = process.env.HOME;
    process.env.HOME = await mkdtemp(path.join(tmpdir(), "muse-test-home-remote-conv-"));
    const museDir = path.join(process.env.HOME, ".muse");
    mkdirSync(museDir, { recursive: true });
    writeFileSync(path.join(museDir, "daemon-offer-shown.json"), JSON.stringify({ offered: true }), "utf8");
  });
  afterEach(() => {
    if (homeEnvBackup === undefined) delete process.env.HOME;
    else process.env.HOME = homeEnvBackup;
  });

  it("a bare remote chat sends NO conversationId, but adopts the server's returned id as the active pointer", async () => {
    const { io } = captureOutput();
    const requests: string[] = [];
    const program = createProgram({
      ...io,
      fetch: async (_url, init) => {
        requests.push(String(init?.body));
        return new Response(JSON.stringify({ conversationId: "conv_serverissued", response: "hi there" }));
      }
    });

    await program.parseAsync(["node", "muse", "chat", "--no-log", "hello"], { from: "node" });

    expect(JSON.parse(requests[0] ?? "{}")).toEqual({ message: "hello" });

    const { activeConversationId } = await import("../src/chat-history.js");
    expect(await activeConversationId()).toBe("conv_serverissued");
  });

  it("--continue sends the ACTIVE conversation id in the request body", async () => {
    const { io } = captureOutput();
    const { startNewConversation } = await import("../src/chat-history.js");
    const activeId = await startNewConversation();

    const requests: string[] = [];
    const program = createProgram({
      ...io,
      fetch: async (_url, init) => {
        requests.push(String(init?.body));
        return new Response(JSON.stringify({ conversationId: activeId, response: "continued" }));
      }
    });

    await program.parseAsync(["node", "muse", "chat", "--no-log", "--continue", "what's next"], { from: "node" });

    expect(JSON.parse(requests[0] ?? "{}")).toMatchObject({ conversationId: activeId, message: "what's next" });
  });

  it("--resume <id> sets the pointer AND sends that id remotely", async () => {
    const { io } = captureOutput();
    const { appendLastChatTurn, startNewConversation, activeConversationId } = await import("../src/chat-history.js");
    const firstId = await activeConversationId();
    await appendLastChatTurn({ message: "first", response: "ok" });
    await startNewConversation();
    await appendLastChatTurn({ message: "second", response: "ok" });

    const requests: string[] = [];
    const program = createProgram({
      ...io,
      fetch: async (_url, init) => {
        requests.push(String(init?.body));
        return new Response(JSON.stringify({ conversationId: firstId, response: "resumed" }));
      }
    });

    await program.parseAsync(["node", "muse", "chat", "--no-log", "--resume", firstId, "continuing"], { from: "node" });

    expect(JSON.parse(requests[0] ?? "{}")).toMatchObject({ conversationId: firstId, message: "continuing" });
    expect(await activeConversationId()).toBe(firstId);
  });

  it("streaming remote chat (--stream) ALSO sends the active id under --continue and adopts the grounding frame's conversationId", async () => {
    const { io, output } = captureOutput();
    const { startNewConversation } = await import("../src/chat-history.js");
    const activeId = await startNewConversation();

    const requests: string[] = [];
    const program = createProgram({
      ...io,
      fetch: async (_url, init) => {
        requests.push(String(init?.body));
        return new Response([
          "event: message\ndata: streamed answer\n\n",
          `event: grounding\ndata: ${JSON.stringify({ answer: "streamed answer", conversationId: activeId })}\n\n`,
          "event: done\ndata:\n\n"
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
    });

    await program.parseAsync(["node", "muse", "chat", "--no-log", "--continue", "--stream", "hi"], { from: "node" });

    expect(JSON.parse(requests[0] ?? "{}")).toMatchObject({ conversationId: activeId });
    expect(output.join("")).toContain("streamed answer");

    const { activeConversationId } = await import("../src/chat-history.js");
    expect(await activeConversationId()).toBe(activeId);
  });

  it("--local is untouched — never reaches the network, so no conversationId round-trip applies", async () => {
    const { io, output } = captureOutput();
    const program = createProgram({
      ...io,
      createRuntimeAssembly: () => ({
        agentRuntime: {
          run: async (input) => ({
            response: { id: "r", model: input.model, output: `local:${input.messages.at(-1)?.content ?? ""}` },
            runId: "local-run-1"
          }),
          stream: async function* () {}
        },
        defaultModel: "test-model"
      }),
      fetch: async () => { throw new Error("must not reach the network"); }
    });

    await program.parseAsync(["node", "muse", "chat", "--local", "--no-log", "hi"], { from: "node" });

    expect(output.join("")).toBe("local:hi\n");
  });
});
