import { describe, expect, it, vi } from "vitest";

import {
  buildImapSearchQuery,
  buildSnippet,
  decodeMimePart,
  decodeQuotedPrintable,
  findPlainTextPart,
  ImapSmtpAuthError,
  ImapSmtpEmailProvider,
  ImapSmtpNetworkError,
  type ImapClientFactory,
  type ImapMailboxClient,
  type SmtpClientFactory,
  type SmtpTransport
} from "../src/email-provider-imap.js";
import type { FetchMessageObject, MailboxObject, MessageStructureObject } from "imapflow";

const PLAIN_STRUCTURE: MessageStructureObject = { encoding: "7bit", type: "text/plain" };

const MULTIPART_STRUCTURE: MessageStructureObject = {
  childNodes: [
    { encoding: "quoted-printable", part: "1", type: "text/plain" },
    { encoding: "base64", part: "2", type: "text/html" }
  ],
  type: "multipart/alternative"
};

const NESTED_MULTIPART_STRUCTURE: MessageStructureObject = {
  childNodes: [
    { encoding: "base64", part: "1", type: "text/html" },
    {
      childNodes: [
        { encoding: "base64", part: "2.1", type: "text/html" },
        { encoding: "7bit", part: "2.2", type: "text/plain" }
      ],
      part: "2",
      type: "multipart/alternative"
    }
  ],
  type: "multipart/mixed"
};

function envelopeFrom(name: string, address: string): FetchMessageObject["envelope"] {
  return { date: new Date("2026-07-01T09:00:00Z"), from: [{ address, name }], subject: "Q3 plan" };
}

/**
 * Contract-faithful fake `ImapMailboxClient`: a fixed set of messages
 * keyed by uid, asserting the exact `mailboxOpen`/`fetch`/`fetchOne`/
 * `search` calls a real `ImapFlow` instance would receive. Never a fake
 * registry — every method mirrors the real signature.
 */
function fakeImapClient(options: {
  readonly messages: readonly FetchMessageObject[];
  readonly bodyParts?: Record<number, Record<string, Buffer>>;
  readonly connectError?: Error;
  readonly exists?: number;
}): { readonly client: ImapMailboxClient; readonly calls: string[] } {
  const calls: string[] = [];
  const client: ImapMailboxClient = {
    connect: async () => {
      calls.push("connect");
      if (options.connectError) throw options.connectError;
    },
    fetch: async function* (range) {
      calls.push(`fetch:${String(range)}`);
      for (const message of options.messages) yield message;
    },
    fetchOne: async (seq, query) => {
      calls.push(`fetchOne:${String(seq)}`);
      const uid = Number(seq);
      const message = options.messages.find((m) => m.uid === uid);
      if (!message) return false;
      if (Array.isArray(query.bodyParts)) {
        const parts = new Map<string, Buffer>();
        for (const key of query.bodyParts) {
          const partKey = typeof key === "string" ? key : key.key;
          const buffer = options.bodyParts?.[uid]?.[partKey];
          if (buffer) parts.set(partKey, buffer);
        }
        return { ...message, bodyParts: parts };
      }
      return message;
    },
    logout: async () => {
      calls.push("logout");
    },
    mailboxOpen: async (path, mailboxOptions) => {
      calls.push(`mailboxOpen:${path}:${String(mailboxOptions?.readOnly)}`);
      return { exists: options.exists ?? options.messages.length } as MailboxObject;
    },
    search: async (query) => {
      calls.push(`search:${JSON.stringify(query)}`);
      return options.messages.map((m) => m.uid);
    }
  };
  return { calls, client };
}

function factoryFor(client: ImapMailboxClient): ImapClientFactory {
  return () => client;
}

describe("email-provider-imap — pure helpers", () => {
  it("findPlainTextPart: a single-part text/plain message addresses its body as \"text\"", () => {
    expect(findPlainTextPart(PLAIN_STRUCTURE)).toBe("text");
  });

  it("findPlainTextPart: picks the text/plain leaf of a multipart/alternative", () => {
    expect(findPlainTextPart(MULTIPART_STRUCTURE)).toBe("1");
  });

  it("findPlainTextPart: recurses into a nested multipart/alternative inside multipart/mixed", () => {
    expect(findPlainTextPart(NESTED_MULTIPART_STRUCTURE)).toBe("2.2");
  });

  it("findPlainTextPart: undefined when there's no text/plain anywhere (HTML-only)", () => {
    expect(findPlainTextPart({ childNodes: [{ encoding: "base64", part: "1", type: "text/html" }], type: "multipart/mixed" })).toBeUndefined();
  });

  it("decodeQuotedPrintable decodes soft breaks and =XX hex escapes", () => {
    expect(decodeQuotedPrintable("Caf=C3=A9 is open=\r\ntomorrow.")).toBe("Café is opentomorrow.");
  });

  it("decodeMimePart routes by encoding (base64 / quoted-printable / plain)", () => {
    expect(decodeMimePart(Buffer.from("aGVsbG8=", "utf8"), "base64")).toBe("hello");
    expect(decodeMimePart(Buffer.from("hi=20there", "latin1"), "quoted-printable")).toBe("hi there");
    expect(decodeMimePart(Buffer.from("plain text", "utf8"))).toBe("plain text");
  });

  it("buildSnippet collapses whitespace and caps length", () => {
    expect(buildSnippet("  line one\n\nline two  ")).toBe("line one line two");
    expect(buildSnippet("x".repeat(300))).toBe(`${"x".repeat(200)}…`);
  });

  it("buildImapSearchQuery maps from:/subject: prefixes, defaults to TEXT", () => {
    expect(buildImapSearchQuery("from:bank@example.com")).toEqual({ from: "bank@example.com" });
    expect(buildImapSearchQuery("subject:invoice")).toEqual({ subject: "invoice" });
    expect(buildImapSearchQuery("paris trip")).toEqual({ text: "paris trip" });
  });
});

describe("ImapSmtpEmailProvider.listRecent", () => {
  it("reads INBOX read-only, newest-first, unread from the absence of \\Seen, snippet from the plain-text part", async () => {
    const messages: FetchMessageObject[] = [
      { bodyStructure: PLAIN_STRUCTURE, envelope: envelopeFrom("Alice", "alice@x.com"), flags: new Set(["\\Seen"]), seq: 1, uid: 101 },
      { bodyStructure: PLAIN_STRUCTURE, envelope: envelopeFrom("Bob", "bob@y.com"), flags: new Set(), seq: 2, uid: 102 }
    ];
    const { calls, client } = fakeImapClient({
      bodyParts: { 101: { text: Buffer.from("First body", "utf8") }, 102: { text: Buffer.from("Second body", "utf8") } },
      messages
    });
    const provider = new ImapSmtpEmailProvider(
      { appPassword: "app-pass-1234567890abcd", email: "user@gmail.com" },
      { imapClientFactory: factoryFor(client) }
    );
    const inbox = await provider.listRecent(10);
    expect(inbox).toEqual([
      { date: "2026-07-01T09:00:00.000Z", from: "Bob <bob@y.com>", id: "102", snippet: "Second body", subject: "Q3 plan", unread: true },
      { date: "2026-07-01T09:00:00.000Z", from: "Alice <alice@x.com>", id: "101", snippet: "First body", subject: "Q3 plan", unread: false }
    ]);
    expect(calls).toContain("mailboxOpen:INBOX:true");
    expect(calls[calls.length - 1]).toBe("logout");
  });

  it("returns [] on an empty mailbox without fetching anything", async () => {
    const { calls, client } = fakeImapClient({ exists: 0, messages: [] });
    const provider = new ImapSmtpEmailProvider({ appPassword: "pw", email: "user@gmail.com" }, { imapClientFactory: factoryFor(client) });
    expect(await provider.listRecent(10)).toEqual([]);
    expect(calls.some((c) => c.startsWith("fetch:"))).toBe(false);
  });
});

describe("ImapSmtpEmailProvider.search / getMessage", () => {
  it("search maps a from: query onto IMAP SEARCH and returns newest-uid-first", async () => {
    const messages: FetchMessageObject[] = [
      { bodyStructure: PLAIN_STRUCTURE, envelope: envelopeFrom("Bank", "bank@ex.com"), flags: new Set(["\\Seen"]), seq: 1, uid: 5 },
      { bodyStructure: PLAIN_STRUCTURE, envelope: envelopeFrom("Bank", "bank@ex.com"), flags: new Set(["\\Seen"]), seq: 2, uid: 9 }
    ];
    const { calls, client } = fakeImapClient({ messages });
    const provider = new ImapSmtpEmailProvider({ appPassword: "pw", email: "user@gmail.com" }, { imapClientFactory: factoryFor(client) });
    const results = await provider.search("from:bank@ex.com", 10);
    expect(results.map((m) => m.id)).toEqual(["9", "5"]);
    expect(calls).toContain(`search:${JSON.stringify({ from: "bank@ex.com" })}`);
  });

  it("search on an empty/whitespace query returns [] without opening a mailbox", async () => {
    const { calls, client } = fakeImapClient({ messages: [] });
    const provider = new ImapSmtpEmailProvider({ appPassword: "pw", email: "user@gmail.com" }, { imapClientFactory: factoryFor(client) });
    expect(await provider.search("   ", 10)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("getMessage fetches the full plain-text body by uid", async () => {
    const messages: FetchMessageObject[] = [
      { bodyStructure: MULTIPART_STRUCTURE, envelope: envelopeFrom("Alice", "alice@x.com"), seq: 1, uid: 42 }
    ];
    const { client } = fakeImapClient({
      bodyParts: { 42: { "1": Buffer.from("Meeting moved to Friday.", "utf8") } },
      messages
    });
    const provider = new ImapSmtpEmailProvider({ appPassword: "pw", email: "user@gmail.com" }, { imapClientFactory: factoryFor(client) });
    const message = await provider.getMessage("42");
    expect(message).toEqual({
      body: "Meeting moved to Friday.",
      date: "2026-07-01T09:00:00.000Z",
      from: "Alice <alice@x.com>",
      id: "42",
      subject: "Q3 plan"
    });
  });

  it("getMessage returns undefined for a non-numeric id without touching the network", async () => {
    const { calls, client } = fakeImapClient({ messages: [] });
    const provider = new ImapSmtpEmailProvider({ appPassword: "pw", email: "user@gmail.com" }, { imapClientFactory: factoryFor(client) });
    expect(await provider.getMessage("not-a-uid")).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("getMessage returns undefined for an unknown uid", async () => {
    const { client } = fakeImapClient({ messages: [] });
    const provider = new ImapSmtpEmailProvider({ appPassword: "pw", email: "user@gmail.com" }, { imapClientFactory: factoryFor(client) });
    expect(await provider.getMessage("999")).toBeUndefined();
  });
});

describe("ImapSmtpEmailProvider — auth / network error classification (safety: password never leaks)", () => {
  it("a login rejection classifies as ImapSmtpAuthError naming the app-password fix, never echoing the password", async () => {
    const authError = Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });
    const { client } = fakeImapClient({ connectError: authError, messages: [] });
    const provider = new ImapSmtpEmailProvider(
      { appPassword: "supersecretpw123456", email: "user@gmail.com" },
      { imapClientFactory: factoryFor(client) }
    );
    await expect(provider.listRecent(5)).rejects.toBeInstanceOf(ImapSmtpAuthError);
    await expect(provider.listRecent(5)).rejects.toThrow(/myaccount\.google\.com\/apppasswords/);
    await expect(provider.listRecent(5)).rejects.not.toThrow(/supersecretpw123456/);
  });

  it("a connection failure classifies as ImapSmtpNetworkError with the password redacted even if the underlying error echoes it", async () => {
    const netError = new Error("connect ECONNREFUSED 1.2.3.4:993 pw=leakedpw999");
    const { client } = fakeImapClient({ connectError: netError, messages: [] });
    const provider = new ImapSmtpEmailProvider(
      { appPassword: "leakedpw999", email: "user@gmail.com" },
      { imapClientFactory: factoryFor(client) }
    );
    const rejection = provider.listRecent(5);
    await expect(rejection).rejects.toBeInstanceOf(ImapSmtpNetworkError);
    await expect(rejection.catch((e: Error) => e.message)).resolves.not.toContain("leakedpw999");
  });

  it("a hung connect() times out into ImapSmtpNetworkError instead of hanging the caller", async () => {
    const client: ImapMailboxClient = {
      connect: () => {
        const { promise } = Promise.withResolvers<void>();
        return promise;
      },
      fetch: async function* () {},
      fetchOne: async () => false,
      logout: async () => undefined,
      mailboxOpen: async () => ({ exists: 0 }) as MailboxObject,
      search: async () => []
    };
    const provider = new ImapSmtpEmailProvider(
      { appPassword: "pw", email: "user@gmail.com" },
      { imapClientFactory: () => client, timeoutMs: 20 }
    );
    await expect(provider.listRecent(5)).rejects.toBeInstanceOf(ImapSmtpNetworkError);
  });
});

describe("ImapSmtpEmailProvider.verifyConnection", () => {
  it("reports the mailbox message count on a successful login (the wizard's immediate-verification step)", async () => {
    const { client } = fakeImapClient({ exists: 7, messages: [] });
    const provider = new ImapSmtpEmailProvider({ appPassword: "pw", email: "user@gmail.com" }, { imapClientFactory: factoryFor(client) });
    await expect(provider.verifyConnection()).resolves.toEqual({ messageCount: 7 });
  });

  it("surfaces the SAME typed auth error the wizard needs to show an actionable message", async () => {
    const authError = Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });
    const { client } = fakeImapClient({ connectError: authError, messages: [] });
    const provider = new ImapSmtpEmailProvider({ appPassword: "pw", email: "user@gmail.com" }, { imapClientFactory: factoryFor(client) });
    await expect(provider.verifyConnection()).rejects.toBeInstanceOf(ImapSmtpAuthError);
  });
});

function fakeSmtpTransport(options: { readonly messageId?: string; readonly sendError?: Error } = {}): { readonly transport: SmtpTransport; readonly closed: () => boolean; readonly sentTo: () => string | undefined } {
  let closed = false;
  let sentTo: string | undefined;
  const transport: SmtpTransport = {
    close: () => {
      closed = true;
    },
    sendMail: async (opts) => {
      sentTo = opts.to;
      if (options.sendError) throw options.sendError;
      return { messageId: options.messageId ?? "msg-1" };
    }
  };
  return { closed: () => closed, sentTo: () => sentTo, transport };
}

function smtpFactoryFor(transport: SmtpTransport): SmtpClientFactory {
  return () => transport;
}

describe("ImapSmtpEmailProvider.sendEmail", () => {
  it("sends via the injected SMTP transport and returns the provider's messageId, always closing the transport", async () => {
    const { closed, sentTo, transport } = fakeSmtpTransport({ messageId: "abc-123" });
    const provider = new ImapSmtpEmailProvider({ appPassword: "pw", email: "user@gmail.com" }, { smtpClientFactory: smtpFactoryFor(transport) });
    const messageId = await provider.sendEmail("bob@y.com", "Hi", "body text");
    expect(messageId).toBe("abc-123");
    expect(sentTo()).toBe("bob@y.com");
    expect(closed()).toBe(true);
  });

  it("a send failure classifies + redacts, and STILL closes the transport", async () => {
    const sendError = Object.assign(new Error("535 Authentication failed"), { code: "EAUTH" });
    const { closed, transport } = fakeSmtpTransport({ sendError });
    const provider = new ImapSmtpEmailProvider({ appPassword: "leakedpw999", email: "user@gmail.com" }, { smtpClientFactory: smtpFactoryFor(transport) });
    await expect(provider.sendEmail("bob@y.com", "Hi", "body")).rejects.toBeInstanceOf(ImapSmtpAuthError);
    expect(closed()).toBe(true);
  });
});

describe("ImapSmtpEmailProvider — default factories never touch a real socket under vitest", () => {
  it("refuses to construct a real ImapFlow / nodemailer client when no factory is injected", async () => {
    const provider = new ImapSmtpEmailProvider({ appPassword: "pw", email: "user@gmail.com" });
    await expect(provider.listRecent(5)).rejects.toThrow(/imapClientFactory/);
    await expect(provider.sendEmail("a@b.com", "s", "b")).rejects.toThrow(/smtpClientFactory/);
  });
});

describe("ImapSmtpEmailProvider — Gmail defaults", () => {
  it("uses imap.gmail.com:993 / smtp.gmail.com:465 unless overridden", async () => {
    const captured: { host: string; port: number }[] = [];
    const imapFactory = vi.fn((config: { readonly host: string; readonly port: number }) => {
      captured.push(config);
      return fakeImapClient({ exists: 0, messages: [] }).client;
    });
    const provider = new ImapSmtpEmailProvider({ appPassword: "pw", email: "user@gmail.com" }, { imapClientFactory: imapFactory });
    await provider.listRecent(5);
    expect(captured[0]).toEqual({ host: "imap.gmail.com", pass: "pw", port: 993, user: "user@gmail.com" });
  });

  it("honors an overridden non-Gmail IMAP host (e.g. Naver)", async () => {
    const captured: { host: string }[] = [];
    const imapFactory = vi.fn((config: { readonly host: string }) => {
      captured.push(config);
      return fakeImapClient({ exists: 0, messages: [] }).client;
    });
    const provider = new ImapSmtpEmailProvider(
      { appPassword: "pw", email: "user@naver.com", imapHost: "imap.naver.com", imapPort: 993 },
      { imapClientFactory: imapFactory }
    );
    await provider.listRecent(5);
    expect(captured[0]?.host).toBe("imap.naver.com");
  });
});

describe("auth-failure diagnostics (live-found: crash + hidden server detail)", () => {
  function authRejectingClient(errorProps: Record<string, unknown>) {
    const events: Record<string, (e: unknown) => void> = {};
    let closed = false;
    const client = {
      close: () => { closed = true; },
      connect: async () => {
        const err = Object.assign(new Error(String(errorProps.message ?? "auth failed")), errorProps);
        throw err;
      },
      fetch: async function* () { yield undefined as never; },
      fetchOne: async () => false as const,
      logout: async () => undefined,
      mailboxOpen: async () => ({ exists: 0 } as never),
      on: (event: string, listener: (e: unknown) => void) => { events[event] = listener; },
      search: async () => false as const
    };
    return {
      client,
      emit: (e: unknown) => events["error"]?.(e),
      hasErrorListener: () => typeof events["error"] === "function",
      wasClosed: () => closed
    };
  }

  it("surfaces the server's rejection line (redacted) in the auth error", async () => {
    const { client } = authRejectingClient({ authenticationFailed: true, responseText: "Invalid credentials secretpass99 (Failure)" });
    const provider = new ImapSmtpEmailProvider(
      { appPassword: "secretpass99", email: "a@gmail.com" },
      { imapClientFactory: () => client }
    );
    const error = await provider.verifyConnection().then(() => undefined, (e: unknown) => e as Error);
    expect(error?.message).toContain('Server said: "Invalid credentials');
    expect(error?.message).not.toContain("secretpass99");
  });

  it("names the DisplayUnlock flow when Google blocks with a web-login demand", async () => {
    const { client } = authRejectingClient({ authenticationFailed: true, responseText: "[ALERT] Please log in via your web browser" });
    const provider = new ImapSmtpEmailProvider(
      { appPassword: "pw", email: "a@gmail.com" },
      { imapClientFactory: () => client }
    );
    const error = await provider.verifyConnection().then(() => undefined, (e: unknown) => e as Error);
    expect(error?.message).toContain("DisplayUnlockCaptcha");
    expect(error?.message).toContain("not a wrong password");
  });

  it("registers the error-event swallower and closes the client on a failed connect (post-rejection socket timeout must not crash)", async () => {
    const { client, emit, hasErrorListener, wasClosed } = authRejectingClient({ authenticationFailed: true });
    const provider = new ImapSmtpEmailProvider(
      { appPassword: "pw", email: "a@gmail.com" },
      { imapClientFactory: () => client }
    );
    await provider.verifyConnection().catch(() => undefined);
    expect(hasErrorListener()).toBe(true);
    expect(wasClosed()).toBe(true);
    expect(() => { emit(new Error("Socket timeout")); }).not.toThrow();
  });
});
