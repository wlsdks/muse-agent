import { describe, expect, it } from "vitest";

import { MessagingProviderError } from "../src/errors.js";
import { MessagingProviderRegistry } from "../src/registry.js";
import type { MessagingProvider, OutboundMessage } from "../src/types.js";

function fakeProvider(id: string, opts: { sink?: { sent?: OutboundMessage }; withInbound?: boolean } = {}): MessagingProvider {
  const provider: MessagingProvider = {
    describe: () => ({ description: `${id} provider`, displayName: id, id }),
    id,
    send: async (message) => {
      if (opts.sink) opts.sink.sent = message;
      return { destination: message.destination, messageId: "m1", providerId: id };
    }
  };
  if (opts.withInbound !== false) {
    return { ...provider, fetchInbound: async () => [{ messageId: "i1", providerId: id, receivedAtIso: "2026-05-31T00:00:00Z", source: "c", text: "inbound" }] };
  }
  return provider;
}

describe("MessagingProviderRegistry — registration + lookup", () => {
  it("registers from the constructor, reports has(), and lists/describes them", () => {
    const reg = new MessagingProviderRegistry([fakeProvider("discord"), fakeProvider("slack")]);
    expect(reg.has("discord")).toBe(true);
    expect(reg.has("telegram")).toBe(false);
    expect(reg.list().map((p) => p.id).sort()).toEqual(["discord", "slack"]);
    expect(reg.describe().map((d) => d.id).sort()).toEqual(["discord", "slack"]);
  });

  it("require() returns a registered provider and throws PROVIDER_NOT_FOUND (with a hint) otherwise", () => {
    const reg = new MessagingProviderRegistry([fakeProvider("discord")]);
    expect(reg.require("discord").id).toBe("discord");
    const err = (() => { try { reg.require("telegram"); } catch (e) { return e; } return undefined; })();
    expect(err).toBeInstanceOf(MessagingProviderError);
    expect((err as MessagingProviderError).code).toBe("PROVIDER_NOT_FOUND");
    expect((err as Error).message).toContain("registered: discord");
  });

  it("the not-found hint says '(none registered)' for an empty registry", () => {
    const reg = new MessagingProviderRegistry();
    const err = (() => { try { reg.require("x"); } catch (e) { return e; } return undefined; })();
    expect((err as Error).message).toContain("(none registered)");
  });

  it("register() overwrites a provider with the same id (last wins, no duplicate error)", () => {
    const reg = new MessagingProviderRegistry([fakeProvider("discord")]);
    const replacement = fakeProvider("discord");
    reg.register(replacement);
    expect(reg.require("discord")).toBe(replacement);
    expect(reg.list()).toHaveLength(1);
  });
});

describe("MessagingProviderRegistry — dispatch", () => {
  it("scrubs credentials from the outbound text at the dispatch chokepoint before the provider sees it", async () => {
    // The registry is the single chokepoint every outbound surface flows
    // through; a leaked secret in agent-generated text must be redacted here so
    // it never reaches a third party even if an upstream scrub was missed.
    const sink: { sent?: OutboundMessage } = {};
    const reg = new MessagingProviderRegistry([fakeProvider("discord", { sink })]);
    await reg.send("discord", { destination: "c", text: "deploy with sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa now" });
    expect(sink.sent!.text).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(sink.sent!.text).toContain("[redacted-anthropic-key]");
    expect(sink.sent!.destination).toBe("c");
  });

  it("dispatches send to the named provider and returns its receipt", async () => {
    const reg = new MessagingProviderRegistry([fakeProvider("discord"), fakeProvider("slack")]);
    const receipt = await reg.send("slack", { destination: "U1", text: "hi" });
    expect(receipt.providerId).toBe("slack");
  });

  it("send to an unknown provider throws PROVIDER_NOT_FOUND", async () => {
    const reg = new MessagingProviderRegistry([fakeProvider("discord")]);
    await expect(reg.send("telegram", { destination: "c", text: "hi" })).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("fetchInbound dispatches when supported and rejects with UPSTREAM_FAILED when the provider lacks it", async () => {
    const reg = new MessagingProviderRegistry([fakeProvider("discord"), fakeProvider("slack", { withInbound: false })]);
    expect(await reg.fetchInbound("discord")).toHaveLength(1);
    const err = await reg.fetchInbound("slack").catch((e: unknown) => e);
    expect((err as MessagingProviderError).code).toBe("UPSTREAM_FAILED");
    expect((err as Error).message).toContain("does not support inbound");
  });
});
