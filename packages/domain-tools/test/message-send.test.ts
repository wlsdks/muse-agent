import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessagingProviderRegistry, OutboundMessage } from "@muse/messaging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MessageDraft } from "../src/message-send.js";
import { sendMessageWithApproval, type SendMessageWithApprovalOptions } from "../src/message-send.js";
import { readActionLog } from "@muse/stores";

let dir: string;
let logFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-msg-send-"));
  logFile = join(dir, "actions.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

function recordingRegistry(): { registry: Pick<MessagingProviderRegistry, "send">; sent: Array<{ providerId: string; message: OutboundMessage }> } {
  const sent: Array<{ providerId: string; message: OutboundMessage }> = [];
  return {
    registry: { send: async (providerId, message) => { sent.push({ message, providerId }); return { destination: message.destination, messageId: "m1", providerId }; } },
    sent
  };
}

const base = (over: Partial<SendMessageWithApprovalOptions> = {}): SendMessageWithApprovalOptions => ({
  actionLogFile: logFile,
  destination: "U123",
  providerId: "discord",
  registry: recordingRegistry().registry,
  text: "hello",
  userId: "u1",
  ...over
});

describe("sendMessageWithApproval — draft-first, fail-closed outbound chat (outbound-safety.md)", () => {
  it("DEFAULT-APPROVE (no self-gate): sends via the registry and logs 'performed' (the gap vs email/web)", async () => {
    const { registry, sent } = recordingRegistry();
    const out = await sendMessageWithApproval(base({ registry }));
    expect(out).toEqual({ destination: "U123", messageId: "m1", sent: true });
    expect(sent).toEqual([{ message: { destination: "U123", text: "hello" }, providerId: "discord" }]);
    expect((await readActionLog(logFile)).at(-1)).toMatchObject({ result: "performed" });
  });

  it("presents the EXACT draft to an injected gate (draft-first)", async () => {
    const { registry } = recordingRegistry();
    let seen: MessageDraft | undefined;
    await sendMessageWithApproval(base({ approvalGate: (d) => { seen = d; return { approved: true }; }, registry }));
    expect(seen).toEqual({ destination: "U123", providerId: "discord", text: "hello" });
  });

  it("DENIED by the injected gate: no send, refusal logged", async () => {
    const { registry, sent } = recordingRegistry();
    const out = await sendMessageWithApproval(base({ approvalGate: () => ({ approved: false, reason: "nope" }), registry }));
    expect(out).toMatchObject({ reason: "denied", sent: false });
    expect(sent).toHaveLength(0);
    expect((await readActionLog(logFile)).at(-1)).toMatchObject({ result: "refused" });
  });

  it("GATE THROWS: fail-closed — no send", async () => {
    const { registry, sent } = recordingRegistry();
    const out = await sendMessageWithApproval(base({ approvalGate: () => { throw new Error("prompt down"); }, registry }));
    expect(out).toMatchObject({ reason: "denied", sent: false });
    expect((out as { detail: string }).detail).toContain("approval gate error");
    expect(sent).toHaveLength(0);
  });

  it("SEND FAILS at the provider: outcome send-failed, logged 'failed'", async () => {
    const registry: Pick<MessagingProviderRegistry, "send"> = { send: async () => { throw new Error("UPSTREAM_FAILED 500"); } };
    const out = await sendMessageWithApproval(base({ registry }));
    expect(out).toMatchObject({ reason: "send-failed", sent: false });
    expect((out as { detail: string }).detail).toContain("UPSTREAM_FAILED 500");
    expect((await readActionLog(logFile)).at(-1)).toMatchObject({ result: "failed" });
  });
});
