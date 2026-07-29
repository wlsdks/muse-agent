import { types as utilTypes } from "node:util";

export const EMAIL_SEND_IDENTITY_PREVIEW_VERSION = "muse.email-send-identity-preview/v1" as const;

export interface EmailRecipientAuthority {
  readonly address: string;
  readonly aliases: readonly string[];
  readonly channel: "email";
  readonly contactId: string;
  readonly displayName: string;
  readonly expiresAt: string;
  readonly observedAt: string;
  readonly source: string;
}

export interface EmailAccountAuthority {
  readonly accountId: string;
  readonly channel: "email";
  readonly expiresAt: string;
  readonly observedAt: string;
  readonly providerId: string;
  readonly source: string;
  readonly workspaceId?: string;
}

export interface EmailSendIdentityPreviewInput {
  readonly account: EmailAccountAuthority;
  readonly now: string;
  readonly recipients: readonly EmailRecipientAuthority[];
  readonly recipientQuery: string;
  readonly requestedAccountId: string;
}

export interface EmailSendIdentityPreview {
  readonly account: Readonly<{
    accountId: string;
    channel: "email";
    expiresAt: string;
    observedAt: string;
    providerId: string;
    source: string;
    workspaceId?: string;
  }>;
  readonly channel: "email";
  readonly destination: Readonly<{
    address: string;
    contactId: string;
    displayName: string;
    expiresAt: string;
    observedAt: string;
    source: string;
  }>;
}

export type EmailSendIdentityPreviewResult =
  | Readonly<{
      canApprove: true;
      canSend: false;
      preview: EmailSendIdentityPreview;
      schemaVersion: typeof EMAIL_SEND_IDENTITY_PREVIEW_VERSION;
      status: "ready";
    }>
  | Readonly<{
      canApprove: false;
      canSend: false;
      candidateContactIds: readonly string[];
      reason:
        | "account-mismatch"
        | "ambiguous-recipient"
        | "invalid-input"
        | "stale-account"
        | "stale-recipient"
        | "unknown-recipient";
      schemaVersion: typeof EMAIL_SEND_IDENTITY_PREVIEW_VERSION;
      status: "held";
    }>;

const RECIPIENT_KEYS = [
  "address",
  "aliases",
  "channel",
  "contactId",
  "displayName",
  "expiresAt",
  "observedAt",
  "source"
] as const;
const ACCOUNT_REQUIRED_KEYS = [
  "accountId",
  "channel",
  "expiresAt",
  "observedAt",
  "providerId",
  "source"
] as const;

/**
 * Resolve one exact email recipient and one fresh sender account into a
 * preview-only identity binding. This function has no sender/provider
 * dependency by design: Task 058 can make identity reviewable, while final
 * payload approval and the external effect remain separate later gates.
 */
export function projectEmailSendIdentityPreview(
  input: EmailSendIdentityPreviewInput
): EmailSendIdentityPreviewResult {
  try {
    const root = exactDataRecord(input, [
      "account",
      "now",
      "recipientQuery",
      "recipients",
      "requestedAccountId"
    ]);
    if (!root) return held("invalid-input");
    const now = canonicalInstant(root["now"]);
    const query = exactText(root["recipientQuery"]);
    const requestedAccountId = exactText(root["requestedAccountId"]);
    const recipients = exactDataArray(root["recipients"]);
    const account = parseAccount(root["account"]);
    if (!now || !query || !requestedAccountId || !recipients || !account) {
      return held("invalid-input");
    }

    const parsedRecipients: EmailRecipientAuthority[] = [];
    for (const rawRecipient of recipients) {
      const recipient = parseRecipient(rawRecipient);
      if (!recipient) return held("invalid-input");
      parsedRecipients.push(recipient);
    }
    if (new Set(parsedRecipients.map((recipient) => recipient.contactId)).size !== parsedRecipients.length) {
      return held("invalid-input");
    }

    const normalizedQuery = normalizeIdentifier(query);
    const matches = parsedRecipients.filter((recipient) =>
      [recipient.displayName, recipient.address, ...recipient.aliases]
        .some((candidate) => normalizeIdentifier(candidate) === normalizedQuery)
    );
    if (matches.length === 0) return held("unknown-recipient");
    if (matches.length !== 1) {
      return held(
        "ambiguous-recipient",
        [...new Set(matches.map((recipient) => recipient.contactId))].sort()
      );
    }
    const recipient = matches[0]!;
    if (!isCurrentAuthority(recipient.observedAt, recipient.expiresAt, now)) {
      return held("stale-recipient", [recipient.contactId]);
    }
    if (account.accountId !== requestedAccountId) {
      return held("account-mismatch", [recipient.contactId]);
    }
    if (!isCurrentAuthority(account.observedAt, account.expiresAt, now)) {
      return held("stale-account", [recipient.contactId]);
    }

    const destination = Object.freeze({
      address: recipient.address,
      contactId: recipient.contactId,
      displayName: recipient.displayName,
      expiresAt: recipient.expiresAt,
      observedAt: recipient.observedAt,
      source: recipient.source
    });
    const accountPreview = Object.freeze({
      accountId: account.accountId,
      channel: "email" as const,
      expiresAt: account.expiresAt,
      observedAt: account.observedAt,
      providerId: account.providerId,
      source: account.source,
      ...(account.workspaceId ? { workspaceId: account.workspaceId } : {})
    });
    return Object.freeze({
      canApprove: true,
      canSend: false,
      preview: Object.freeze({
        account: accountPreview,
        channel: "email" as const,
        destination
      }),
      schemaVersion: EMAIL_SEND_IDENTITY_PREVIEW_VERSION,
      status: "ready" as const
    });
  } catch {
    return held("invalid-input");
  }
}

function parseRecipient(value: unknown): EmailRecipientAuthority | undefined {
  const record = exactDataRecord(value, RECIPIENT_KEYS);
  if (!record || record["channel"] !== "email") return undefined;
  const aliases = exactDataArray(record["aliases"]);
  if (!aliases) return undefined;
  const parsedAliases = aliases.map(exactText);
  const address = exactEmail(record["address"]);
  const contactId = exactText(record["contactId"]);
  const displayName = exactText(record["displayName"]);
  const expiresAt = canonicalInstant(record["expiresAt"]);
  const observedAt = canonicalInstant(record["observedAt"]);
  const source = exactText(record["source"]);
  if (
    parsedAliases.some((alias) => alias === undefined)
    || !address
    || !contactId
    || !displayName
    || !expiresAt
    || !observedAt
    || !source
  ) {
    return undefined;
  }
  return {
    address,
    aliases: parsedAliases as string[],
    channel: "email",
    contactId,
    displayName,
    expiresAt,
    observedAt,
    source
  };
}

function parseAccount(value: unknown): EmailAccountAuthority | undefined {
  const record = exactDataRecord(
    value,
    ACCOUNT_REQUIRED_KEYS,
    ["workspaceId"]
  );
  if (!record || record["channel"] !== "email") return undefined;
  const accountId = exactText(record["accountId"]);
  const expiresAt = canonicalInstant(record["expiresAt"]);
  const observedAt = canonicalInstant(record["observedAt"]);
  const providerId = exactText(record["providerId"]);
  const source = exactText(record["source"]);
  const hasWorkspaceId = Object.hasOwn(record, "workspaceId");
  const workspaceId = hasWorkspaceId ? exactText(record["workspaceId"]) : undefined;
  if (!accountId || !expiresAt || !observedAt || !providerId || !source) {
    return undefined;
  }
  if (hasWorkspaceId && !workspaceId) return undefined;
  return {
    accountId,
    channel: "email",
    expiresAt,
    observedAt,
    providerId,
    source,
    ...(workspaceId ? { workspaceId } : {})
  };
}

function exactDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return undefined;
  const stringKeys = keys as string[];
  if (requiredKeys.some((key) => !stringKeys.includes(key))) return undefined;
  if (stringKeys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    output[key] = descriptor.value;
  }
  return output;
}

function exactDataArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  const expected = Array.from({ length: value.length }, (_unused, index) => index.toString());
  if (
    keys.length !== expected.length + 1
    || keys.at(-1) !== "length"
    || expected.some((key, index) => keys[index] !== key)
  ) {
    return undefined;
  }
  const output: unknown[] = [];
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    output.push(descriptor.value);
  }
  return output;
}

function exactText(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    ? value
    : undefined;
}

function exactEmail(value: unknown): string | undefined {
  const text = exactText(value);
  return text && /^[^@\s]+@[^@\s]+$/u.test(text) ? text : undefined;
}

function canonicalInstant(value: unknown): string | undefined {
  const text = exactText(value);
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === text
    ? text
    : undefined;
}

function normalizeIdentifier(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function isCurrentAuthority(observedAt: string, expiresAt: string, now: string): boolean {
  const observed = Date.parse(observedAt);
  const expires = Date.parse(expiresAt);
  const current = Date.parse(now);
  return observed <= current && current < expires && observed < expires;
}

function held(
  reason: Extract<EmailSendIdentityPreviewResult, { status: "held" }>["reason"],
  candidateContactIds: readonly string[] = []
): Extract<EmailSendIdentityPreviewResult, { status: "held" }> {
  return Object.freeze({
    canApprove: false,
    canSend: false,
    candidateContactIds: Object.freeze([...candidateContactIds]),
    reason,
    schemaVersion: EMAIL_SEND_IDENTITY_PREVIEW_VERSION,
    status: "held" as const
  });
}
