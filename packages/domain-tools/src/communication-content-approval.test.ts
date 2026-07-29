import { describe, expect, it } from "vitest";

import {
  bindCommunicationContentApproval,
  COMMUNICATION_CONTENT_APPROVAL_VERSION,
  verifyCommunicationContentApproval,
  type CommunicationContent
} from "./communication-content-approval.js";

const APPROVED_AT = "2026-07-29T02:00:00.000Z";
const EXPIRES_AT = "2026-07-29T02:05:00.000Z";
const AUTHORITY_KEY = Uint8Array.from({ length: 32 }, (_unused, index) => index + 1);

function content(overrides: Partial<CommunicationContent> = {}): CommunicationContent {
  return {
    attachments: [
      {
        attachmentId: "agenda",
        bytes: Uint8Array.from([1, 2, 3]),
        fileName: "agenda.pdf",
        mediaType: "application/pdf"
      },
      {
        attachmentId: "notes",
        bytes: Uint8Array.from([4, 5]),
        fileName: "notes.txt",
        mediaType: "text/plain"
      }
    ],
    channel: "email",
    destination: "alex@example.com",
    effectId: "effect-email-059",
    text: "See you tomorrow.",
    ...overrides
  };
}

function bind(value: CommunicationContent = content()) {
  return bindCommunicationContentApproval({
    approvalId: "approval-059",
    approvedAt: APPROVED_AT,
    authorityKey: AUTHORITY_KEY,
    content: value,
    expiresAt: EXPIRES_AT
  });
}

describe("communication content approval binding", () => {
  it("binds exact text and ordered attachment bytes without mutating input", () => {
    const source = content();
    const before = structuredClone(source);
    const result = bind(source);

    expect(result.status).toBe("bound");
    if (result.status !== "bound") throw new Error("expected bound approval");
    expect(result.binding).toMatchObject({
      approvalId: "approval-059",
      approvedAt: APPROVED_AT,
      channel: "email",
      destination: "alex@example.com",
      effectId: "effect-email-059",
      expiresAt: EXPIRES_AT,
      schemaVersion: COMMUNICATION_CONTENT_APPROVAL_VERSION,
      textByteLength: 17
    });
    expect(result.binding.attachments.map(({ attachmentId, byteLength, order }) => ({
      attachmentId,
      byteLength,
      order
    }))).toEqual([
      { attachmentId: "agenda", byteLength: 3, order: 0 },
      { attachmentId: "notes", byteLength: 2, order: 1 }
    ]);
    expect(source).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.binding)).toBe(true);
    expect(Object.isFrozen(result.binding.attachments)).toBe(true);
    expect(result.binding.attachments.every(Object.isFrozen)).toBe(true);
  });

  it("authorizes only the exact unchanged candidate before exclusive expiry", () => {
    const approval = bind();
    if (approval.status !== "bound") throw new Error("expected bound approval");
    expect(verifyCommunicationContentApproval({
      approval: approval.binding,
      authorityKey: AUTHORITY_KEY,
      candidate: content(),
      now: "2026-07-29T02:04:59.999Z"
    })).toEqual({
      canSend: true,
      contentDigest: approval.binding.contentDigest,
      status: "authorized"
    });
  });

  it.each([
    ["text", content({ text: "Changed text." })],
    [
      "attachment bytes",
      content({
        attachments: [
          { ...content().attachments[0]!, bytes: Uint8Array.from([1, 2, 4]) },
          content().attachments[1]!
        ]
      })
    ],
    ["attachment order", content({ attachments: [...content().attachments].reverse() })],
    [
      "attachment filename",
      content({
        attachments: [
          { ...content().attachments[0]!, fileName: "changed.pdf" },
          content().attachments[1]!
        ]
      })
    ],
    ["destination", content({ destination: "other@example.com" })],
    ["effect identity", content({ effectId: "other-effect" })]
  ])("invalidates approval when %s changes and keeps provider send count at zero", (_name, candidate) => {
    const approval = bind();
    if (approval.status !== "bound") throw new Error("expected bound approval");
    let sendCount = 0;
    const verification = verifyCommunicationContentApproval({
      approval: approval.binding,
      authorityKey: AUTHORITY_KEY,
      candidate,
      now: "2026-07-29T02:01:00.000Z"
    });
    if (verification.canSend) sendCount += 1;
    expect(verification).toEqual({
      canSend: false,
      reason: "content-changed",
      status: "held"
    });
    expect(sendCount).toBe(0);
  });

  it.each([
    ["at expiry", EXPIRES_AT],
    ["before approval", "2026-07-29T01:59:59.999Z"]
  ])("holds an otherwise exact candidate %s", (_name, now) => {
    const approval = bind();
    if (approval.status !== "bound") throw new Error("expected bound approval");
    expect(verifyCommunicationContentApproval({
      approval: approval.binding,
      authorityKey: AUTHORITY_KEY,
      candidate: content(),
      now
    })).toEqual({ canSend: false, reason: "expired", status: "held" });
  });

  it("fails closed on duplicate attachment IDs, malformed lifetime, proxies, and hidden fields", () => {
    let proxyTraps = 0;
    const proxiedAttachments = new Proxy([...content().attachments], {
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      }
    });
    const duplicateAttachments = [
      content().attachments[0]!,
      { ...content().attachments[1]!, attachmentId: "agenda" }
    ];
    const proxiedKey = new Proxy(AUTHORITY_KEY, {
      getPrototypeOf(target) {
        proxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      }
    });
    expect(bind(content({ attachments: duplicateAttachments }))).toEqual({
      reason: "invalid-input",
      status: "held"
    });
    expect(bindCommunicationContentApproval({
      approvalId: "approval-059",
      approvedAt: EXPIRES_AT,
      authorityKey: AUTHORITY_KEY,
      content: content(),
      expiresAt: EXPIRES_AT
    })).toEqual({ reason: "invalid-lifetime", status: "held" });
    expect(bind(content({ attachments: proxiedAttachments }))).toEqual({
      reason: "invalid-input",
      status: "held"
    });
    expect(bindCommunicationContentApproval({
      approvalId: "approval-059",
      approvedAt: APPROVED_AT,
      authorityKey: proxiedKey,
      content: content(),
      expiresAt: EXPIRES_AT
    })).toEqual({ reason: "invalid-input", status: "held" });
    expect(bindCommunicationContentApproval({
      approvalId: "approval-059",
      approvedAt: APPROVED_AT,
      authorityKey: AUTHORITY_KEY,
      content: { ...content(), hidden: true },
      expiresAt: EXPIRES_AT
    } as never)).toEqual({ reason: "invalid-input", status: "held" });
    expect(proxyTraps).toBe(0);
  });

  it.each([
    ["approval identity", { approvalId: "other-approval" }],
    ["approval time", { approvedAt: "2026-07-29T02:00:01.000Z" }],
    ["expiry", { expiresAt: "2026-07-29T02:06:00.000Z" }],
    ["text length", { textByteLength: 999 }]
  ])("rejects a tampered %s before provider dispatch", (_name, mutation) => {
    const result = bind();
    if (result.status !== "bound") throw new Error("expected bound approval");
    const tampered = { ...structuredClone(result.binding), ...mutation };
    expect(verifyCommunicationContentApproval({
      approval: tampered,
      authorityKey: AUTHORITY_KEY,
      candidate: content(),
      now: "2026-07-29T02:01:00.000Z"
    })).toEqual({ canSend: false, reason: "invalid-approval", status: "held" });
  });

  it("rejects a wrong approval authority key", () => {
    const result = bind();
    if (result.status !== "bound") throw new Error("expected bound approval");
    expect(verifyCommunicationContentApproval({
      approval: result.binding,
      authorityKey: Uint8Array.from({ length: 32 }, () => 255),
      candidate: content(),
      now: "2026-07-29T02:01:00.000Z"
    })).toEqual({ canSend: false, reason: "invalid-approval", status: "held" });
  });
});
