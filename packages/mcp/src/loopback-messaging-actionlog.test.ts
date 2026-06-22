import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { createLoopbackMcpConnection } from "./loopback.js";
import { createMessagingMcpServer } from "./loopback-messaging.js";
import { readActionLog } from "@muse/stores";

function fakeTelegram(): MessagingProvider {
  return {
    describe: () => ({ id: "telegram", displayName: "Telegram", configured: true }),
    id: "telegram",
    send: async (message: OutboundMessage): Promise<OutboundReceipt> => ({
      destination: message.destination,
      messageId: "42",
      providerId: "telegram"
    })
  } as unknown as MessagingProvider;
}

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-msg-tool-")), "action-log.json");
}

describe("muse.messaging.send — outbound-safety recording (F-1)", () => {
  it("appends a `performed` action-log entry when wired with an APPROVING gate", async () => {
    const file = logFile();
    const server = createMessagingMcpServer({
      actionLogFile: file,
      approvalGate: () => ({ approved: true }),
      registry: new MessagingProviderRegistry([fakeTelegram()]),
      userId: "stark"
    });
    const connection = createLoopbackMcpConnection(server);

    const sent = await connection.callTool!("send", { destination: "@me", providerId: "telegram", text: "hi" });
    expect(sent).toMatchObject({ destination: "@me", messageId: "42" });

    const log = await readActionLog(file);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ result: "performed", userId: "stark" });
    expect(log[0]!.what).toContain("telegram");
  });

  it("FAIL-CLOSES (no auto-send) when wired in production WITHOUT a draft-first gate — the outbound-safety hole", async () => {
    const file = logFile();
    // Production wiring is actionLogFile + userId but NO approvalGate (the agent's
    // loopback path). It must NOT auto-send to a third party.
    const server = createMessagingMcpServer({ actionLogFile: file, registry: new MessagingProviderRegistry([fakeTelegram()]), userId: "stark" });
    const out = await createLoopbackMcpConnection(server).callTool!("send", { destination: "@me", providerId: "telegram", text: "hi" }) as { error?: string; refused?: boolean };
    expect(out.refused).toBe(true); // not sent
    const log = await readActionLog(file);
    expect(log.some((entry) => entry.result === "refused")).toBe(true);
    expect(log.some((entry) => entry.result === "performed")).toBe(false);
  });
});

function fakeProvider(id: string, sent?: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ configured: true, displayName: id, id }),
    id,
    send: async (message: OutboundMessage): Promise<OutboundReceipt> => {
      sent?.push(message);
      return { destination: message.destination, messageId: "m1", providerId: id };
    }
  } as unknown as MessagingProvider;
}

describe("muse.messaging.send — resolve the channel from config, never fail on the model's guess (gate proven, not just the happy path)", () => {
  it("uses the SINGLE configured provider even when providerId is omitted (with an approving gate)", async () => {
    const sent: OutboundMessage[] = [];
    const server = createMessagingMcpServer({ actionLogFile: logFile(), approvalGate: () => ({ approved: true }), registry: new MessagingProviderRegistry([fakeProvider("slack", sent)]), userId: "stark" });
    const out = await createLoopbackMcpConnection(server).callTool!("send", { destination: "C123", text: "hi" });
    expect(out).toMatchObject({ providerId: "slack" });
    expect(sent).toHaveLength(1);
  });

  it("uses the single provider even when the model GUESSES a wrong/unregistered providerId (the defect)", async () => {
    const sent: OutboundMessage[] = [];
    const server = createMessagingMcpServer({ actionLogFile: logFile(), approvalGate: () => ({ approved: true }), registry: new MessagingProviderRegistry([fakeProvider("slack", sent)]), userId: "stark" });
    const out = await createLoopbackMcpConnection(server).callTool!("send", { destination: "C123", providerId: "telegram", text: "hi" });
    expect(out).toMatchObject({ providerId: "slack" }); // resolved to the configured one, not the guess
    expect(sent).toHaveLength(1);
  });

  it("MULTIPLE providers + missing/unknown providerId → ASK (error lists them), sends NOTHING", async () => {
    const sentA: OutboundMessage[] = []; const sentB: OutboundMessage[] = [];
    const server = createMessagingMcpServer({ actionLogFile: logFile(), registry: new MessagingProviderRegistry([fakeProvider("slack", sentA), fakeProvider("discord", sentB)]), userId: "stark" });
    const out = await createLoopbackMcpConnection(server).callTool!("send", { destination: "C123", text: "hi" }) as { error?: string };
    expect(out.error).toMatch(/slack/u);
    expect(out.error).toMatch(/discord/u);
    expect(sentA).toHaveLength(0);
    expect(sentB).toHaveLength(0);
  });

  it("ZERO providers configured → error, sends nothing", async () => {
    const server = createMessagingMcpServer({ actionLogFile: logFile(), registry: new MessagingProviderRegistry([]), userId: "stark" });
    const out = await createLoopbackMcpConnection(server).callTool!("send", { destination: "C123", text: "hi" }) as { error?: string };
    expect(out.error).toMatch(/no messaging provider/iu);
  });

  it("the draft-first gate STILL fail-closes after resolution — a DENY sends nothing + logs a refusal", async () => {
    const sent: OutboundMessage[] = [];
    const file = logFile();
    const server = createMessagingMcpServer({
      actionLogFile: file,
      approvalGate: () => ({ approved: false, reason: "user denied" }),
      registry: new MessagingProviderRegistry([fakeProvider("slack", sent)]),
      userId: "stark"
    });
    const out = await createLoopbackMcpConnection(server).callTool!("send", { destination: "C123", text: "hi" }) as { refused?: boolean };
    expect(sent).toHaveLength(0); // resolution succeeded, but the gate blocked the send
    expect(out.refused).toBe(true);
    const log = await readActionLog(file);
    expect(log.some((entry) => entry.result === "refused")).toBe(true);
  });
});
