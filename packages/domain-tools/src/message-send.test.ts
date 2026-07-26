import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, TelegramProvider, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { sendMessageWithApproval, type MessageApprovalGate } from "./message-send.js";
import { readActionLog } from "@muse/stores";

interface SentRecord {
  readonly providerId: string;
  readonly destination: string;
  readonly text: string;
}

// Contract-faithful fake of the registry transport boundary: records
// every send so a test asserts the message actually left (or didn't),
// never a fake "did it" flag. Optionally throws to model a 5xx.
function fakeRegistry(throwOnSend = false): {
  registry: { send(providerId: string, message: { destination: string; text: string }): Promise<OutboundReceipt> };
  sends: SentRecord[];
  attempts: () => number;
} {
  const sends: SentRecord[] = [];
  let attempts = 0;
  return {
    attempts: () => attempts,
    registry: {
      send: async (providerId, message): Promise<OutboundReceipt> => {
        attempts += 1;
        if (throwOnSend) {
          throw new Error("upstream 503");
        }
        sends.push({ destination: message.destination, providerId, text: message.text });
        return { destination: message.destination, messageId: "msg_1", providerId: providerId as OutboundReceipt["providerId"] };
      }
    },
    sends
  };
}

const deny: MessageApprovalGate = () => ({ approved: false, reason: "user declined" });
const throwingGate: MessageApprovalGate = () => {
  throw new Error("approval prompt undeliverable");
};

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-msg-send-")), "action-log.json");
}

describe("sendMessageWithApproval — outbound-safety contract", () => {
  it("CONFIRM: with no self-gate (runtime gate is the confirmation) the send fires once and logs `performed`", async () => {
    const { registry, sends } = fakeRegistry();
    const file = logFile();
    const outcome = await sendMessageWithApproval({
      actionLogFile: file,
      destination: "@stark",
      effectId: "effect-confirm",
      providerId: "telegram",
      registry,
      text: "deploy finished",
      userId: "stark"
    });
    expect(outcome).toEqual({
      destination: "@stark",
      effectId: "effect-confirm",
      messageId: "msg_1",
      sent: true
    });
    expect(sends).toEqual([{ destination: "@stark", providerId: "telegram", text: "deploy finished" }]);
    const log = await readActionLog(file);
    expect(log[0]).toMatchObject({ result: "performed", userId: "stark" });
    expect(log[0]!.what).toContain("telegram");
  });

  it("DENY: an injected gate that denies blocks the send entirely and logs `refused`", async () => {
    const { registry, sends } = fakeRegistry();
    const file = logFile();
    const outcome = await sendMessageWithApproval({
      actionLogFile: file,
      approvalGate: deny,
      destination: "@stark",
      effectId: "effect-deny",
      providerId: "telegram",
      registry,
      text: "deploy finished",
      userId: "stark"
    });
    expect(outcome).toMatchObject({ reason: "denied", sent: false });
    expect(sends).toHaveLength(0);
    const log = await readActionLog(file);
    expect(log[0]).toMatchObject({ result: "refused" });
  });

  it("TIMEOUT: a gate that throws is fail-closed — no send, logged `refused`", async () => {
    const { registry, sends } = fakeRegistry();
    const file = logFile();
    const outcome = await sendMessageWithApproval({
      actionLogFile: file,
      approvalGate: throwingGate,
      destination: "@stark",
      effectId: "effect-gate-timeout",
      providerId: "telegram",
      registry,
      text: "deploy finished",
      userId: "stark"
    });
    expect(outcome).toMatchObject({ reason: "denied", sent: false });
    expect(sends).toHaveLength(0);
    const log = await readActionLog(file);
    expect(log[0]).toMatchObject({ result: "refused" });
  });

  it("SEND-FAILED: a transport error is logged `failed` and reported, never a false success", async () => {
    const { registry, sends, attempts } = fakeRegistry(true);
    const file = logFile();
    const outcome = await sendMessageWithApproval({
      actionLogFile: file,
      destination: "@stark",
      effectId: "effect-provider-failure",
      providerId: "telegram",
      registry,
      text: "deploy finished",
      userId: "stark"
    });
    expect(outcome).toMatchObject({ reason: "send-unknown", sent: false });
    expect(sends).toHaveLength(0);
    // No provider advertises a native idempotency key, so an ambiguous error is
    // never retried automatically.
    expect(attempts()).toBe(1);
    const log = await readActionLog(file);
    expect(log[0]).toMatchObject({ result: "failed" });
  });
});

describe("sendMessageWithApproval — transient-resilience (contract-faithful real provider)", () => {
  function fakeFetchSequence(responses: readonly (() => Response)[]): { fetch: typeof globalThis.fetch; calls: () => number } {
    let i = 0;
    return {
      calls: () => i,
      fetch: (async () => {
        const make = responses[Math.min(i, responses.length - 1)]!;
        i += 1;
        return make();
      }) as unknown as typeof globalThis.fetch
    };
  }

  it("a 429 is ambiguous without provider-native dedupe and is not retried", async () => {
    const { fetch, calls } = fakeFetchSequence([
      () => new Response(JSON.stringify({ description: "Too Many Requests", ok: false, parameters: { retry_after: 0 } }), { status: 429 }),
      () => new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 })
    ]);
    const registry = new MessagingProviderRegistry([
      new TelegramProvider({ baseUrl: "https://api.telegram.test", fetch, token: "t" })
    ]);
    const file = logFile();
    const outcome = await sendMessageWithApproval({
      actionLogFile: file,
      destination: "12345",
      effectId: "effect-429",
      providerId: "telegram",
      registry,
      text: "ship it",
      userId: "stark"
    });
    expect(outcome).toMatchObject({ effectId: "effect-429", reason: "send-unknown", sent: false });
    expect(calls()).toBe(1);
    const log = await readActionLog(file);
    expect(log[0]).toMatchObject({ result: "failed" });
  });

  it("a permanent 401 (bad token) is NOT retried — fails fast, logged `failed`", async () => {
    const { fetch, calls } = fakeFetchSequence([
      () => new Response(JSON.stringify({ description: "Unauthorized", ok: false }), { status: 401 })
    ]);
    const registry = new MessagingProviderRegistry([
      new TelegramProvider({ baseUrl: "https://api.telegram.test", fetch, token: "bad" })
    ]);
    const file = logFile();
    const outcome = await sendMessageWithApproval({
      actionLogFile: file,
      destination: "12345",
      effectId: "effect-401",
      providerId: "telegram",
      registry,
      text: "ship it",
      userId: "stark"
    });
    expect(outcome).toMatchObject({ reason: "send-unknown", sent: false });
    expect(calls()).toBe(1); // a 401 is permanent — no wasted retries
    const log = await readActionLog(file);
    expect(log[0]).toMatchObject({ result: "failed" });
  });
});
