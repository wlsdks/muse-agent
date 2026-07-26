import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOutboundEffect } from "@muse/messaging";
import type { Contact } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { GmailEmailProvider, type EmailSender } from "./email-provider.js";
import {
  sendEmailWithApproval,
  type EmailApprovalGate,
  type SendEmailWithApprovalOptions
} from "./email-send.js";

const CONTACTS: readonly Contact[] = [
  { email: "alice@example.com", id: "alice", name: "Alice" }
];

function fixture(): {
  readonly actionLogFile: string;
  readonly effectFile: string;
  readonly dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "muse-email-effect-"));
  return {
    actionLogFile: join(dir, "action-log.json"),
    dir,
    effectFile: join(dir, "outbound-effects.json")
  };
}

function options(
  files: ReturnType<typeof fixture>,
  sender: EmailSender,
  over: Partial<SendEmailWithApprovalOptions> = {}
): SendEmailWithApprovalOptions {
  return {
    actionLogFile: files.actionLogFile,
    approvalGate: () => ({ approved: true }),
    body: "Exact approved body",
    contacts: CONTACTS,
    effectId: "effect-email-1",
    recipientQuery: "Alice",
    sender,
    subject: "Exact subject",
    userId: "stark",
    ...over
  };
}

describe("durable email effects", () => {
  it.each([
    ["denial", () => ({ approved: false, reason: "declined" })],
    ["gate throw", () => { throw new Error("prompt timeout"); }]
  ] as const)("%s creates no ledger and makes no provider call", async (_name, approvalGate) => {
    const files = fixture();
    let sends = 0;
    const sender: EmailSender = {
      sendEmail: async () => {
        sends += 1;
        return "unexpected";
      }
    };
    const outcome = await sendEmailWithApproval(options(files, sender, {
      approvalGate: approvalGate as EmailApprovalGate
    }));
    expect(outcome).toMatchObject({ reason: "denied", sent: false });
    expect(sends).toBe(0);
    expect(existsSync(files.effectFile)).toBe(false);
  });

  it("an invalid effect id creates no ledger and makes no provider call", async () => {
    const files = fixture();
    let sends = 0;
    const outcome = await sendEmailWithApproval(options(files, {
      sendEmail: async () => {
        sends += 1;
        return "unexpected";
      }
    }, { effectId: " bad\nid " }));
    expect(outcome).toMatchObject({ reason: "invalid-input", sent: false });
    expect(sends).toBe(0);
    expect(existsSync(files.effectFile)).toBe(false);
  });

  it("rejects a Unicode C1 control character in an effect id before ledger or send", async () => {
    const files = fixture();
    let sends = 0;
    const outcome = await sendEmailWithApproval(options(files, {
      sendEmail: async () => {
        sends += 1;
        return "unexpected";
      }
    }, { effectId: "bad\u0085id" }));
    expect(outcome).toMatchObject({ reason: "invalid-input", sent: false });
    expect(sends).toBe(0);
    expect(existsSync(files.effectFile)).toBe(false);
  });

  it("rejects an effect id over 256 UTF-8 bytes before ledger or send", async () => {
    const files = fixture();
    let sends = 0;
    const outcome = await sendEmailWithApproval(options(files, {
      sendEmail: async () => {
        sends += 1;
        return "unexpected";
      }
    }, { effectId: "é".repeat(129) }));
    expect(outcome).toMatchObject({ reason: "invalid-input", sent: false });
    expect(sends).toBe(0);
    expect(existsSync(files.effectFile)).toBe(false);
  });

  it.each([
    ["ambiguous", [
      { email: "alice-1@example.com", id: "alice-1", name: "Alice" },
      { email: "alice-2@example.com", id: "alice-2", name: "Alice" }
    ]],
    ["unknown", []]
  ] as const)("%s recipient creates no ledger and makes no provider call", async (_name, contacts) => {
    const files = fixture();
    let sends = 0;
    const outcome = await sendEmailWithApproval(options(files, {
      sendEmail: async () => {
        sends += 1;
        return "unexpected";
      }
    }, { contacts }));
    expect(outcome).toMatchObject({
      reason: _name === "ambiguous" ? "ambiguous-recipient" : "unknown-recipient",
      sent: false
    });
    expect(sends).toBe(0);
    expect(existsSync(files.effectFile)).toBe(false);
  });

  it("accepts once, then exact replay after restart makes zero provider calls", async () => {
    const files = fixture();
    let sends = 0;
    const sender: EmailSender = {
      sendEmail: async () => {
        sends += 1;
        return "provider-message-1";
      }
    };
    const first = await sendEmailWithApproval(options(files, sender));
    expect(first).toMatchObject({
      effectId: "effect-email-1",
      messageId: "provider-message-1",
      sent: true
    });
    const restartSender: EmailSender = {
      sendEmail: async () => {
        throw new Error("restart replay must not call provider");
      }
    };
    const replay = await sendEmailWithApproval(options(files, restartSender));
    expect(replay).toEqual(first);
    expect(sends).toBe(1);
    expect(await readOutboundEffect(files.effectFile, "effect-email-1")).toMatchObject({
      receipt: { messageId: "provider-message-1" },
      state: "accepted"
    });
  });

  const unknownCases: ReadonlyArray<readonly [
    string,
    () => Promise<string | undefined>
  ]> = [
    ["throw-before-proof", async (): Promise<string | undefined> => { throw new Error("network timeout"); }],
    ["success-before-ack", async (): Promise<string | undefined> => { throw new Error("connection lost after write"); }],
    ["missing receipt", async (): Promise<string | undefined> => undefined],
    ["blank receipt", async (): Promise<string | undefined> => " \t "]
  ];

  it.each(unknownCases)("%s becomes durable unknown and replay makes zero provider calls", async (_name, firstSend) => {
    const files = fixture();
    let calls = 0;
    const first = await sendEmailWithApproval(options(files, {
      sendEmail: async () => {
        calls += 1;
        return firstSend();
      }
    }, { effectId: `effect-${_name}` }));
    expect(first).toMatchObject({ reason: "send-unknown", sent: false });
    const replay = await sendEmailWithApproval(options(files, {
      sendEmail: async () => {
        calls += 1;
        return "must-not-send";
      }
    }, { effectId: `effect-${_name}` }));
    expect(replay).toMatchObject({ reason: "send-unknown", sent: false });
    expect(calls).toBe(1);
    expect(await readOutboundEffect(files.effectFile, `effect-${_name}`)).toMatchObject({
      state: "unknown"
    });
  });

  it("same effect id with exact payload drift conflicts and makes zero extra provider calls", async () => {
    const files = fixture();
    let calls = 0;
    const sender: EmailSender = {
      sendEmail: async () => {
        calls += 1;
        return "provider-message-drift";
      }
    };
    expect(await sendEmailWithApproval(options(files, sender))).toMatchObject({ sent: true });
    const drift = await sendEmailWithApproval(options(files, sender, { body: "Changed body" }));
    expect(drift).toMatchObject({ reason: "send-failed", sent: false });
    if (drift.sent) throw new Error("payload drift must not be accepted");
    expect(drift.detail).toContain("different payload");
    expect(calls).toBe(1);
  });

  it("an explicit effect file writes only that file, not the derived action-log sibling", async () => {
    const files = fixture();
    const explicitEffectFile = join(files.dir, "injected-effects.json");
    const outcome = await sendEmailWithApproval(options(files, {
      sendEmail: async () => "provider-message-explicit-file"
    }, {
      effectFile: explicitEffectFile,
      effectId: "effect-explicit-file"
    }));
    expect(outcome).toMatchObject({ sent: true });
    expect(existsSync(explicitEffectFile)).toBe(true);
    expect(existsSync(files.effectFile)).toBe(false);
  });

  it("action log stores only a 200-character body preview while the ledger still binds the exact body", async () => {
    const files = fixture();
    const secretMarker = "SECRET_AFTER_PREVIEW_BOUNDARY";
    const originalBody = `${"a".repeat(250)}${secretMarker}`;
    let calls = 0;
    const sender: EmailSender = {
      sendEmail: async () => {
        calls += 1;
        return "provider-message-private-log";
      }
    };
    expect(await sendEmailWithApproval(options(files, sender, {
      body: originalBody,
      effectId: "effect-private-action-log"
    }))).toMatchObject({ sent: true });
    const actionLogBytes = readFileSync(files.actionLogFile, "utf8");
    expect(actionLogBytes).toContain("bodyPreview");
    expect(actionLogBytes).not.toContain(secretMarker);

    const drift = await sendEmailWithApproval(options(files, sender, {
      body: `${"a".repeat(250)}DIFFERENT_TAIL`,
      effectId: "effect-private-action-log"
    }));
    expect(drift).toMatchObject({ reason: "send-failed", sent: false });
    expect(calls).toBe(1);
  });

  it("snapshots mutable inputs before approval awaits", async () => {
    const files = fixture();
    const observed: Array<{ readonly body: string; readonly subject: string; readonly to: string }> = [];
    type MutableOptions = {
      -readonly [K in keyof SendEmailWithApprovalOptions]: SendEmailWithApprovalOptions[K]
    };
    const mutable: MutableOptions = {
      ...options(files, {
        sendEmail: async (to, subject, body) => {
          observed.push({ body, subject, to });
          return "provider-message-snapshot";
        }
      }),
      approvalGate: async (draft) => {
        expect(draft).toMatchObject({
          body: "Original body",
          effectId: "effect-email-1",
          subject: "Original subject",
          to: "alice@example.com"
        });
        mutable.body = "Mutated body";
        mutable.subject = "Mutated subject";
        await Promise.resolve();
        return { approved: true };
      },
      body: "Original body",
      subject: "Original subject"
    };
    expect(await sendEmailWithApproval(mutable)).toMatchObject({ sent: true });
    expect(observed).toEqual([{
      body: "Original body",
      subject: "Original subject",
      to: "alice@example.com"
    }]);
  });

  it("an action-log failure after accepted cannot downgrade or double-send", async () => {
    const files = fixture();
    mkdirSync(files.actionLogFile);
    let calls = 0;
    const sender: EmailSender = {
      sendEmail: async () => {
        calls += 1;
        return "provider-message-audit";
      }
    };
    const first = await sendEmailWithApproval(options(files, sender));
    expect(first).toMatchObject({ messageId: "provider-message-audit", sent: true });
    const replay = await sendEmailWithApproval(options(files, sender));
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    expect(await readOutboundEffect(files.effectFile, "effect-email-1")).toMatchObject({
      state: "accepted"
    });
  });

  it("Gmail may retry explicit pre-accept 429 rejections, but records at most one accepted effect", async () => {
    const files = fixture();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 3
        ? new Response("rate limited", { status: 429 })
        : new Response(JSON.stringify({ id: "gmail-accepted-1" }), { status: 200 });
    }) as typeof globalThis.fetch;
    const sender = new GmailEmailProvider("token", fetchImpl, {
      baseDelayMs: 0,
      retries: 2,
      sleep: async () => undefined
    });
    const first = await sendEmailWithApproval(options(files, sender, {
      effectId: "effect-gmail-429"
    }));
    expect(first).toMatchObject({ messageId: "gmail-accepted-1", sent: true });
    expect(calls).toBe(3);
    const replay = await sendEmailWithApproval(options(files, sender, {
      effectId: "effect-gmail-429"
    }));
    expect(replay).toEqual(first);
    expect(calls).toBe(3);
    expect(await readOutboundEffect(files.effectFile, "effect-gmail-429")).toMatchObject({
      receipt: { messageId: "gmail-accepted-1" },
      state: "accepted"
    });
  });

  it("exhausted Gmail 429 pre-accept rejections record no accepted effect", async () => {
    const files = fixture();
    let calls = 0;
    const sender = new GmailEmailProvider("token", (async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    }) as typeof globalThis.fetch, {
      baseDelayMs: 0,
      retries: 2,
      sleep: async () => undefined
    });
    const outcome = await sendEmailWithApproval(options(files, sender, {
      effectId: "effect-gmail-429-exhausted"
    }));
    expect(outcome).toMatchObject({ reason: "send-unknown", sent: false });
    expect(calls).toBe(3);
    expect(await readOutboundEffect(files.effectFile, "effect-gmail-429-exhausted")).toMatchObject({
      state: "unknown"
    });
  });
});
