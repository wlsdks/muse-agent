import { A2ASafetyError, type A2AEnvelope } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { A2A_SIGNATURE_HEADER, sendToPeer } from "../src/transport.js";

const ENV = { MUSE_A2A_ENABLED: "true" } as const;
const peer = { id: "phone", secret: "shared-swarm-key", url: "https://phone.test/a2a" };

function captureFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ init: init ?? {}, url: String(url) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("sendToPeer — only signed, redacted know-how leaves Muse", () => {
  it("POSTs a redacted, signed skill envelope as an A2A JSON-RPC data part", async () => {
    const { calls, fetchImpl } = captureFetch();
    const result = await sendToPeer({
      env: ENV,
      fetchImpl,
      fromPeerId: "laptop",
      outbound: { content: "Fix VPN: MTU 1380. token=sk-abc123", kind: "skill" },
      peer,
      redact: (text) => text.replace(/sk-[a-z0-9]+/gu, "[redacted]")
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(peer.url);
    expect((calls[0]!.init.headers as Record<string, string>)[A2A_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/u);
    const request = JSON.parse(String(calls[0]!.init.body)) as {
      readonly jsonrpc: string;
      readonly method: string;
      readonly params: { readonly message: { readonly parts: readonly { readonly data: A2AEnvelope; readonly kind: string }[] } };
    };
    expect(request).toMatchObject({ jsonrpc: "2.0", method: "message/send" });
    expect(request.params.message.parts[0]).toMatchObject({
      data: { fromPeerId: "laptop", kind: "skill" },
      kind: "data"
    });
    expect(request.params.message.parts[0]!.data.content).not.toContain("sk-abc123");
  });

  it("sends nothing when A2A is disabled", async () => {
    const { calls, fetchImpl } = captureFetch();
    await expect(sendToPeer({
      env: {},
      fetchImpl,
      fromPeerId: "laptop",
      outbound: { content: "x", kind: "skill" },
      peer
    })).rejects.toThrow(A2ASafetyError);
    expect(calls).toHaveLength(0);
  });

  it("refuses to send a non-know-how payload", async () => {
    const { calls, fetchImpl } = captureFetch();
    await expect(sendToPeer({
      env: ENV,
      fetchImpl,
      fromPeerId: "laptop",
      outbound: { content: "my private note", kind: "note" as never },
      peer
    })).rejects.toThrow(A2ASafetyError);
    expect(calls).toHaveLength(0);
  });
});
