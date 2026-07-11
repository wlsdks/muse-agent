import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MessagingProviderRegistry,
  createThreadedInboundRunner,
  respondToInbound,
  type InboundAgentRunner
} from "../src/index.js";
import type { InboundMessage, MessagingProvider } from "../src/types.js";

// Conversation-scope capability profiles (P7-3): `InboundMessage.scope`
// must survive the whole reply pipeline — respondToInbound → the
// (possibly threaded) runner → the caller's agent-run input — so
// apps/api's inbound-agent-run can gate pairing/memory/tools on it.
// A message that drops `scope` on the way through silently reopens the
// group-chat safety hole this slice closes.

function makeProvider(id: string): MessagingProvider {
  return {
    id: id as MessagingProvider["id"],
    describe: () => ({ id: id as MessagingProvider["id"], displayName: id, configured: true }),
    send: async (message) => ({ destination: message.destination, messageId: `${id}-out`, providerId: id as MessagingProvider["id"] })
  };
}

function inbound(over: Partial<InboundMessage> & Pick<InboundMessage, "messageId" | "text">): InboundMessage {
  return {
    providerId: "telegram",
    receivedAtIso: "2026-05-18T16:00:00.000Z",
    source: "chat-1",
    ...over
  } as InboundMessage;
}

describe("respondToInbound threads scope into the runner", () => {
  it("passes each message's scope through to InboundAgentRunner.run", async () => {
    const registry = new MessagingProviderRegistry([makeProvider("telegram")]);
    const seenScopes: (string | undefined)[] = [];
    const runner: InboundAgentRunner = {
      run: async (input) => {
        seenScopes.push((input as { readonly scope?: string }).scope);
        return "ok";
      }
    };

    await respondToInbound({
      messages: [
        inbound({ messageId: "m1", scope: "direct", text: "hi" }),
        inbound({ messageId: "m2", scope: "shared", text: "hi all" }),
        inbound({ messageId: "m3", text: "no scope stamped" })
      ],
      registry,
      runner
    });

    expect(seenScopes).toEqual(["direct", "shared", undefined]);
  });
});

describe("createThreadedInboundRunner threads scope into the wrapped run", () => {
  it("passes the inbound scope through on every call, independent of thread history", async () => {
    const threadFile = join(mkdtempSync(join(tmpdir(), "muse-thread-scope-")), "threads.json");
    const seenScopes: (string | undefined)[] = [];
    const runner = createThreadedInboundRunner({
      run: async (input) => {
        seenScopes.push((input as { readonly scope?: string }).scope);
        return "reply";
      },
      threadFile
    });

    await runner.run({ providerId: "telegram", scope: "direct", source: "chat-1", text: "hi" } as Parameters<InboundAgentRunner["run"]>[0]);
    await runner.run({ providerId: "telegram", scope: "shared", source: "chat-2", text: "hi all" } as Parameters<InboundAgentRunner["run"]>[0]);

    expect(seenScopes).toEqual(["direct", "shared"]);
  });
});
