import { describe, expect, it } from "vitest";

import { createEmailReadTool, type EmailProvider, type EmailSummary } from "../src/index.js";

const MESSAGES: EmailSummary[] = [
  { from: "Jane <jane@x.com>", id: "m1", snippet: "project deadline moved", subject: "Project", unread: true },
  { from: "billing@v.com", id: "m2", snippet: "invoice attached", subject: "Invoice", unread: false }
];

function provider(messages: EmailSummary[] = MESSAGES, onLimit?: (n: number) => void): EmailProvider {
  return {
    async listRecent(limit: number) {
      onLimit?.(limit);
      return messages;
    }
  };
}

describe("createEmailReadTool — on-demand inbox perception", () => {
  it("is risk:read and lists recent messages (sender/subject/unread)", async () => {
    const out = await createEmailReadTool({ provider: provider() }).execute({}) as { count: number; messages: Array<{ from: string; unread: boolean }> };
    expect(out.count).toBe(2);
    expect(out.messages[0]).toMatchObject({ from: "Jane <jane@x.com>", unread: true });
    expect(createEmailReadTool({ provider: provider() }).definition.risk).toBe("read");
  });

  it("unreadOnly filters to unread messages", async () => {
    const out = await createEmailReadTool({ provider: provider() }).execute({ unreadOnly: true }) as { count: number; messages: Array<{ subject: string }> };
    expect(out.count).toBe(1);
    expect(out.messages[0]!.subject).toBe("Project");
  });

  it("clamps limit to 1..50 and passes it to the provider", async () => {
    let seen = -1;
    await createEmailReadTool({ provider: provider(MESSAGES, (n) => { seen = n; }) }).execute({ limit: 999 });
    expect(seen).toBe(50);
  });

  it("a provider error degrades to an empty list with the error (never throws)", async () => {
    const throwing: EmailProvider = { listRecent: async () => { throw new Error("gmail 503"); } };
    const out = await createEmailReadTool({ provider: throwing }).execute({}) as { messages: unknown[]; error?: string };
    expect(out.messages).toEqual([]);
    expect(out.error).toContain("gmail 503");
  });
});
