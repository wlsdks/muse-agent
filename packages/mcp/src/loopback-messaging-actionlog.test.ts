import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { createLoopbackMcpConnection } from "./loopback.js";
import { createMessagingMcpServer } from "./loopback-messaging.js";
import { readActionLog } from "./personal-action-log-store.js";

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
  it("appends a `performed` action-log entry when wired with actionLogFile + userId", async () => {
    const file = logFile();
    const server = createMessagingMcpServer({
      actionLogFile: file,
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
});
