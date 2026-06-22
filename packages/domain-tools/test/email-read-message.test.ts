import { describe, expect, it } from "vitest";

import { GmailAuthError, GmailEmailProvider, createEmailReadMessageTool, extractPlainTextBody } from "../src/index.js";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("extractPlainTextBody — pull plain text from a Gmail payload", () => {
  it("reads a direct text/plain body", () => {
    expect(extractPlainTextBody({ body: { data: b64url("hello world") }, mimeType: "text/plain" })).toBe("hello world");
  });

  it("prefers the text/plain part of a multipart, ignoring text/html", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { body: { data: b64url("<b>html</b>") }, mimeType: "text/html" },
        { body: { data: b64url("the plain text") }, mimeType: "text/plain" }
      ]
    };
    expect(extractPlainTextBody(payload)).toBe("the plain text");
  });

  it("returns '' when there's no plain-text part", () => {
    expect(extractPlainTextBody({ body: { data: b64url("x") }, mimeType: "text/html" })).toBe("");
    expect(extractPlainTextBody(undefined)).toBe("");
  });
});

function gmailFetch(status: number, body: unknown) {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;
}

const FULL_MSG = {
  id: "m1",
  payload: {
    headers: [{ name: "From", value: "Jane <jane@x.com>" }, { name: "Subject", value: "Project" }, { name: "Date", value: "2026-05-20" }],
    mimeType: "text/plain",
    body: { data: b64url("The full project plan is attached.") }
  },
  snippet: "The full project plan"
};

describe("GmailEmailProvider.getMessage + read_email tool", () => {
  it("getMessage returns the parsed full body + headers", async () => {
    const provider = new GmailEmailProvider("tok", gmailFetch(200, FULL_MSG), { baseDelayMs: 0, sleep: async () => {} });
    const msg = await provider.getMessage("m1");
    expect(msg).toMatchObject({ from: "Jane <jane@x.com>", id: "m1", subject: "Project", body: "The full project plan is attached." });
  });

  it("a 404 / unreachable → undefined (never throws)", async () => {
    const provider = new GmailEmailProvider("tok", gmailFetch(404, {}), { baseDelayMs: 0, retries: 0, sleep: async () => {} });
    expect(await provider.getMessage("nope")).toBeUndefined();
  });

  it("read_email tool is risk:read and returns the full body, found:false for empty/unknown id", async () => {
    const provider = new GmailEmailProvider("tok", gmailFetch(200, FULL_MSG), { baseDelayMs: 0, sleep: async () => {} });
    const tool = createEmailReadMessageTool({ reader: provider });
    expect(tool.definition.risk).toBe("read");
    const out = await tool.execute({ id: "m1" }) as { found: boolean; body?: string };
    expect(out).toMatchObject({ found: true, body: "The full project plan is attached." });
    expect(await tool.execute({ id: "" })).toMatchObject({ found: false });
  });

  it("getMessage propagates GmailAuthError on 401 (a permanent credential failure is not hidden as 'not found')", async () => {
    const provider = new GmailEmailProvider("tok", gmailFetch(401, {}), { baseDelayMs: 0, retries: 0, sleep: async () => {} });
    await expect(provider.getMessage("m1")).rejects.toBeInstanceOf(GmailAuthError);
  });

  it("read_email surfaces the auth failure as the reason, not a misleading 'no message with that id'", async () => {
    const provider = new GmailEmailProvider("tok", gmailFetch(401, {}), { baseDelayMs: 0, retries: 0, sleep: async () => {} });
    const tool = createEmailReadMessageTool({ reader: provider });
    const out = await tool.execute({ id: "m1" }) as { found: boolean; reason?: string };
    expect(out.found).toBe(false);
    expect(out.reason).toContain("auth rejected");
    expect(out.reason).not.toContain("no message with that id");
  });
});
