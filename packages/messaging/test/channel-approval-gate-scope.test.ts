import { describe, expect, it, vi } from "vitest";

import { createChannelApprovalGate, type ChannelApprovalRefusal } from "../src/channel-approval-gate.js";
import type { MessagingProviderRegistry } from "../src/registry.js";

// Conversation-scope capability profiles (P7-3): a write/execute tool
// reached from a SHARED (group/channel) chat is denied outright — no
// draft-then-approve dance, because approving from a group would let
// ANY member of that chat "yes" a risky action on the owner's behalf.
// A DIRECT (1:1) chat keeps today's draft-first approval-prompt flow
// unchanged (regression guard).

function fakeRegistry(send: (providerId: string, message: { destination: string; text: string }) => Promise<void>) {
  return { send: vi.fn(send) } as unknown as MessagingProviderRegistry & {
    send: ReturnType<typeof vi.fn>;
  };
}

function gateInput(name: string, risk: "read" | "write" | "execute", args?: Record<string, unknown>) {
  return { risk, runId: "run-1", toolCall: { arguments: args, name }, userId: "tg:group-1" };
}

describe("createChannelApprovalGate — shared (group) scope", () => {
  it("denies a write/execute tool outright in shared scope, with a group-unavailable notice (not an approval prompt)", async () => {
    const registry = fakeRegistry(async () => {});
    const gate = createChannelApprovalGate({ providerId: "telegram", registry, scope: "shared", source: "-100123" });
    const decision = await gate(gateInput("email_send", "execute", { subject: "Q3", to: "bob@example.com" }));
    expect(decision.allowed).toBe(false);
    expect(registry.send).toHaveBeenCalledTimes(1);
    const posted = registry.send.mock.calls[0]![1] as { text: string };
    expect(posted.text.toLowerCase()).toContain("group");
    // Must not promise an approval round-trip that a group "yes" could hijack.
    expect(posted.text.toLowerCase()).not.toContain("approval");
    expect(posted.text.toLowerCase()).not.toContain("approve");
  });

  it("still records the refusal for the audit trail in shared scope (the caller decides whether it becomes a re-runnable pending item)", async () => {
    const registry = fakeRegistry(async () => {});
    const recordRefusal = vi.fn(async (_refusal: ChannelApprovalRefusal) => {});
    const gate = createChannelApprovalGate({ providerId: "telegram", recordRefusal, registry, scope: "shared", source: "-100123" });
    await gate(gateInput("email_send", "execute", { subject: "Q3", to: "bob@example.com" }));
    expect(recordRefusal).toHaveBeenCalledTimes(1);
  });

  it("lets read tools through untouched in shared scope, same as direct", async () => {
    const registry = fakeRegistry(async () => {});
    const gate = createChannelApprovalGate({ providerId: "telegram", registry, scope: "shared", source: "-100123" });
    const decision = await gate(gateInput("knowledge_search", "read"));
    expect(decision.allowed).toBe(true);
    expect(registry.send).not.toHaveBeenCalled();
  });

  it("direct scope (or omitted, the default) is BYTE-IDENTICAL to today's draft-first approval flow", async () => {
    const registry = fakeRegistry(async () => {});
    const gateDirect = createChannelApprovalGate({ providerId: "telegram", registry, scope: "direct", source: "42" });
    const decisionDirect = await gateDirect(gateInput("email_send", "execute", { subject: "Q3", to: "bob@example.com" }));

    const registryDefault = fakeRegistry(async () => {});
    const gateDefault = createChannelApprovalGate({ providerId: "telegram", registry: registryDefault, source: "42" });
    const decisionDefault = await gateDefault(gateInput("email_send", "execute", { subject: "Q3", to: "bob@example.com" }));

    expect(decisionDirect).toEqual(decisionDefault);
    const textDirect = (registry.send.mock.calls[0]![1] as { text: string }).text;
    const textDefault = (registryDefault.send.mock.calls[0]![1] as { text: string }).text;
    expect(textDirect).toBe(textDefault);
    expect(textDirect).toContain("NOT executed");
    expect(textDirect.toLowerCase()).toContain("approval");
  });
});
