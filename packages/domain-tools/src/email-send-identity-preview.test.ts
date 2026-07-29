import { describe, expect, it } from "vitest";

import {
  EMAIL_SEND_IDENTITY_PREVIEW_VERSION,
  projectEmailSendIdentityPreview,
  type EmailSendIdentityPreviewInput
} from "./email-send-identity-preview.js";

const NOW = "2026-07-29T02:00:00.000Z";

function recipient(
  overrides: Partial<EmailSendIdentityPreviewInput["recipients"][number]> = {}
): EmailSendIdentityPreviewInput["recipients"][number] {
  return {
    address: "alex@example.com",
    aliases: ["Alex", "project lead"],
    channel: "email",
    contactId: "contact-alex",
    displayName: "Alex Kim",
    expiresAt: "2026-07-29T03:00:00.000Z",
    observedAt: "2026-07-29T01:00:00.000Z",
    source: "contacts.json#contact-alex",
    ...overrides
  };
}

function input(
  overrides: Partial<EmailSendIdentityPreviewInput> = {}
): EmailSendIdentityPreviewInput {
  return {
    account: {
      accountId: "personal@example.com",
      channel: "email",
      expiresAt: "2026-07-29T03:00:00.000Z",
      observedAt: "2026-07-29T01:30:00.000Z",
      providerId: "gmail-oauth",
      source: "credential-probe:gmail-personal",
      workspaceId: "personal"
    },
    now: NOW,
    recipientQuery: "Alex",
    recipients: [recipient()],
    requestedAccountId: "personal@example.com",
    ...overrides
  };
}

describe("projectEmailSendIdentityPreview", () => {
  it("projects one exact recipient, account, workspace, channel, source, and expiry without enabling send", () => {
    const source = input();
    const before = structuredClone(source);
    const result = projectEmailSendIdentityPreview(source);

    expect(result).toEqual({
      canApprove: true,
      canSend: false,
      preview: {
        account: {
          accountId: "personal@example.com",
          channel: "email",
          expiresAt: "2026-07-29T03:00:00.000Z",
          observedAt: "2026-07-29T01:30:00.000Z",
          providerId: "gmail-oauth",
          source: "credential-probe:gmail-personal",
          workspaceId: "personal"
        },
        channel: "email",
        destination: {
          address: "alex@example.com",
          contactId: "contact-alex",
          displayName: "Alex Kim",
          expiresAt: "2026-07-29T03:00:00.000Z",
          observedAt: "2026-07-29T01:00:00.000Z",
          source: "contacts.json#contact-alex"
        }
      },
      schemaVersion: EMAIL_SEND_IDENTITY_PREVIEW_VERSION,
      status: "ready"
    });
    expect(source).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status === "ready" && Object.isFrozen(result.preview)).toBe(true);
    expect(result.status === "ready" && Object.isFrozen(result.preview.account)).toBe(true);
    expect(result.status === "ready" && Object.isFrozen(result.preview.destination)).toBe(true);
  });

  it.each([
    {
      name: "alias collision",
      expected: { candidateContactIds: ["contact-alex", "contact-sasha"], reason: "ambiguous-recipient" },
      value: input({
        recipients: [
          recipient(),
          recipient({
            address: "sasha@example.com",
            aliases: ["Alex"],
            contactId: "contact-sasha",
            displayName: "Sasha Lee",
            source: "contacts.json#contact-sasha"
          })
        ]
      })
    },
    {
      name: "ambiguous display name",
      expected: { candidateContactIds: ["contact-alex", "contact-sasha"], reason: "ambiguous-recipient" },
      value: input({
        recipientQuery: "Alex Kim",
        recipients: [
          recipient({ aliases: [] }),
          recipient({
            address: "sasha@example.com",
            aliases: [],
            contactId: "contact-sasha",
            source: "contacts.json#contact-sasha"
          })
        ]
      })
    },
    {
      name: "unknown recipient",
      expected: { candidateContactIds: [], reason: "unknown-recipient" },
      value: input({ recipientQuery: "Unknown" })
    },
    {
      name: "requested account drift",
      expected: { candidateContactIds: ["contact-alex"], reason: "account-mismatch" },
      value: input({ requestedAccountId: "work@example.com" })
    },
    {
      name: "stale account authority",
      expected: { candidateContactIds: ["contact-alex"], reason: "stale-account" },
      value: input({
        account: {
          ...input().account,
          expiresAt: "2026-07-29T01:59:59.999Z"
        }
      })
    },
    {
      name: "account authority at its exclusive expiry boundary",
      expected: { candidateContactIds: ["contact-alex"], reason: "stale-account" },
      value: input({
        account: {
          ...input().account,
          expiresAt: NOW
        }
      })
    },
    {
      name: "future account observation",
      expected: { candidateContactIds: ["contact-alex"], reason: "stale-account" },
      value: input({
        account: {
          ...input().account,
          observedAt: "2026-07-29T02:00:00.001Z"
        }
      })
    },
    {
      name: "stale recipient authority",
      expected: { candidateContactIds: ["contact-alex"], reason: "stale-recipient" },
      value: input({
        recipients: [recipient({ expiresAt: "2026-07-29T01:59:59.999Z" })]
      })
    },
    {
      name: "recipient authority at its exclusive expiry boundary",
      expected: { candidateContactIds: ["contact-alex"], reason: "stale-recipient" },
      value: input({
        recipients: [recipient({ expiresAt: NOW })]
      })
    }
  ])("holds $name before approval or provider dispatch", ({ expected, value }) => {
    let providerCalls = 0;
    const result = projectEmailSendIdentityPreview(value);
    if (result.canSend) providerCalls += 1;
    expect(result).toMatchObject({
      canApprove: false,
      canSend: false,
      schemaVersion: EMAIL_SEND_IDENTITY_PREVIEW_VERSION,
      status: "held",
      ...expected
    });
    expect(providerCalls).toBe(0);
  });

  it("fails closed on hidden fields, getters, malformed authority, and noncanonical timestamps without executing accessors", () => {
    let getterCalls = 0;
    const getterAccount = {};
    for (const [key, value] of Object.entries(input().account)) {
      Object.defineProperty(getterAccount, key, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return value;
        }
      });
    }
    const symbolRecipient = recipient() as EmailSendIdentityPreviewInput["recipients"][number] & {
      [key: symbol]: boolean;
    };
    symbolRecipient[Symbol("hidden")] = true;
    const sparseRecipients = [recipient({ channel: "email" }), recipient(), recipient()];
    delete sparseRecipients[1];
    let proxyTrapCalls = 0;
    const proxiedRecipients = new Proxy([recipient()], {
      getPrototypeOf(target) {
        proxyTrapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        proxyTrapCalls += 1;
        return Reflect.ownKeys(target);
      }
    });
    const inheritedRecipients = [recipient()];
    Object.setPrototypeOf(inheritedRecipients, null);
    const cases: unknown[] = [
      { ...input(), account: getterAccount },
      { ...input(), recipients: [symbolRecipient] },
      { ...input(), account: { ...input().account, hidden: true } },
      {
        ...input(),
        account: {
          ...input().account,
          workspaceId: undefined
        }
      },
      { ...input(), now: "2026-07-29T02:00:00Z" },
      { ...input(), recipients: [recipient({ address: "not-an-email" })] },
      { ...input(), recipients: sparseRecipients },
      { ...input(), recipients: proxiedRecipients },
      { ...input(), recipients: inheritedRecipients },
      {
        ...input(),
        recipients: [
          recipient(),
          recipient({
            address: "unrelated@example.com",
            aliases: ["Unrelated"],
            contactId: "contact-alex",
            displayName: "Unrelated",
            source: "contacts.json#duplicate-contact-alex"
          })
        ]
      }
    ];

    for (const value of cases) {
      expect(projectEmailSendIdentityPreview(value as EmailSendIdentityPreviewInput)).toMatchObject({
        canApprove: false,
        canSend: false,
        reason: "invalid-input",
        status: "held"
      });
    }
    expect(getterCalls).toBe(0);
    expect(proxyTrapCalls).toBe(0);
  });
});
