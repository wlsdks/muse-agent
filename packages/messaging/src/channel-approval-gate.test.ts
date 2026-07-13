import { describe, expect, it, vi } from "vitest";

import { createChannelApprovalGate, summarizeToolDraft, type ChannelApprovalRefusal } from "./channel-approval-gate.js";
import type { MessagingProviderRegistry } from "./registry.js";

function fakeRegistry(send: (providerId: string, message: { destination: string; text: string }) => Promise<void>) {
  return { send: vi.fn(send) } as unknown as MessagingProviderRegistry & {
    send: ReturnType<typeof vi.fn>;
  };
}

function gateInput(name: string, risk: "read" | "write" | "execute", args?: Record<string, unknown>) {
  return { risk, runId: "run-1", toolCall: { arguments: args, name }, userId: "tg:42" };
}

describe("createChannelApprovalGate", () => {
  it("lets read tools through without posting anything", async () => {
    const registry = fakeRegistry(async () => {});
    const gate = createChannelApprovalGate({ providerId: "telegram", registry, source: "42" });
    const decision = await gate(gateInput("muse.search", "read"));
    expect(decision.allowed).toBe(true);
    expect(registry.send).not.toHaveBeenCalled();
  });

  it("egressBlocked: a read tool with a runtime egress deny is NOT auto-allowed (same swallow the CLI gate had)", async () => {
    const registry = fakeRegistry(async () => {});
    const gate = createChannelApprovalGate({ providerId: "telegram", registry, source: "42" });
    const decision = await gate({
      ...gateInput("browser_open", "read", { url: "https://evil.example/exfil" }),
      egressBlocked: true,
      egressWarning: "URL was not observed anywhere this run — looks model-composed"
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("egress denied");
    expect(decision.reason).toContain("model-composed");
    // No approval-prompt round trip for an egress deny — it isn't a
    // pending-approval write/execute, it's a hard deny.
    expect(registry.send).not.toHaveBeenCalled();
  });

  it("egress CONFIRM (not blocked) on a read tool still passes through silently", async () => {
    const registry = fakeRegistry(async () => {});
    const gate = createChannelApprovalGate({ providerId: "telegram", registry, source: "42" });
    const decision = await gate({
      ...gateInput("browser_open", "read", { url: "https://portal.example/details" }),
      egressWarning: "quoted from a page read this run — link-following under the fan-out cap"
    });
    expect(decision.allowed).toBe(true);
    expect(registry.send).not.toHaveBeenCalled();
  });

  it("denies a risky tool and posts an approval prompt carrying the draft", async () => {
    const registry = fakeRegistry(async () => {});
    const gate = createChannelApprovalGate({ providerId: "telegram", registry, source: "42" });
    const decision = await gate(
      gateInput("email_send", "execute", { body: "Long body that should not be echoed", subject: "Q3 numbers", to: "bob@example.com" })
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("email_send");
    expect(registry.send).toHaveBeenCalledTimes(1);
    const posted = registry.send.mock.calls[0]![1] as { destination: string; text: string };
    expect(posted.destination).toBe("42");
    expect(posted.text).toContain("email_send");
    expect(posted.text).toContain("bob@example.com");
    expect(posted.text).toContain("Q3 numbers");
    // The bulk/sensitive body must NOT be echoed into the chat transcript.
    expect(posted.text).not.toContain("Long body");
    // Honest affordance: the prompt must not promise that a reply runs
    // the tool (no approve-completion round-trip exists yet).
    expect(posted.text).toContain("NOT executed");
    expect(posted.text.toLowerCase()).not.toContain("reply to approve");
  });

  it("stays fail-closed when posting the approval prompt throws", async () => {
    const registry = fakeRegistry(async () => {
      throw new Error("network down");
    });
    const gate = createChannelApprovalGate({ providerId: "telegram", registry, source: "42" });
    const decision = await gate(gateInput("web_action", "execute", { url: "http://x.test/book" }));
    expect(decision.allowed).toBe(false);
    expect(registry.send).toHaveBeenCalledTimes(1);
  });

  it("records a refused risky tool (tool/risk/draft/userId) for the action trail; not for read tools", async () => {
    const registry = fakeRegistry(async () => {});
    const recordRefusal = vi.fn(async (_refusal: ChannelApprovalRefusal) => {});
    const gate = createChannelApprovalGate({ providerId: "telegram", recordRefusal, registry, source: "42" });

    await gate(gateInput("muse.search", "read"));
    expect(recordRefusal).not.toHaveBeenCalled();

    await gate(gateInput("email_send", "execute", { body: "secret", subject: "Q3", to: "bob@example.com" }));
    expect(recordRefusal).toHaveBeenCalledTimes(1);
    expect(recordRefusal.mock.calls[0]![0]).toEqual({
      arguments: { body: "secret", subject: "Q3", to: "bob@example.com" },
      draft: 'to bob@example.com, subject "Q3"',
      risk: "execute",
      tool: "email_send",
      userId: "tg:42"
    });
  });

  it("stays fail-closed when the refusal recorder throws (a wedged disk can't let a risky tool through)", async () => {
    const registry = fakeRegistry(async () => {});
    const recordRefusal = vi.fn(async () => {
      throw new Error("disk full");
    });
    const gate = createChannelApprovalGate({ providerId: "telegram", recordRefusal, registry, source: "42" });
    const decision = await gate(gateInput("web_action", "execute", { url: "http://x.test/book" }));
    expect(decision.allowed).toBe(false);
    expect(recordRefusal).toHaveBeenCalledTimes(1);
    expect(registry.send).toHaveBeenCalledTimes(1); // still posts the prompt
  });
});

describe("summarizeToolDraft", () => {
  it("renders recipient + subject for email_send, omitting the body", () => {
    const draft = summarizeToolDraft("email_send", { body: "secret body", subject: "Hi", to: "bob@example.com" });
    expect(draft).toBe('to bob@example.com, subject "Hi"');
    expect(draft).not.toContain("secret body");
  });

  it("renders method + url for web_action (default POST)", () => {
    expect(summarizeToolDraft("web_action", { url: "http://x.test/book" })).toBe("POST http://x.test/book");
    expect(summarizeToolDraft("web_action", { method: "PUT", url: "http://x.test/y" })).toBe("PUT http://x.test/y");
  });

  it("renders service + entity for home_action", () => {
    expect(summarizeToolDraft("home_action", { entity: "light.living_room", service: "light.turn_off" })).toBe(
      "light.turn_off on light.living_room"
    );
    expect(summarizeToolDraft("home_action", { service: "lock.lock" })).toBe("lock.lock");
  });

  it("renders a short generic key=value list for unknown tools, skipping objects", () => {
    const draft = summarizeToolDraft("some_tool", { count: 3, nested: { a: 1 }, query: "weather" });
    expect(draft).toContain("count=3");
    expect(draft).toContain("query=weather");
    expect(draft).not.toContain("nested");
  });

  it("caps the generic key=value draft at 3 scalar entries and drops null/undefined values (bounded, signal-dense approval prompt)", () => {
    // The approval prompt the user reads to approve/deny must stay concise: an
    // unknown tool with many args shows only the first 3 non-null/undefined
    // SCALAR entries, never an unbounded dump that buries the decision. Here b
    // (null) + d (undefined) are dropped → [a, c, e, f] → the 3-cap drops f.
    const draft = summarizeToolDraft("some_tool", { a: 1, b: null, c: 3, d: undefined, e: 5, f: 6 });
    expect(draft).toBe("a=1, c=3, e=5");
  });

  it("returns empty string when there are no arguments", () => {
    expect(summarizeToolDraft("email_send", undefined)).toBe("");
  });
});
