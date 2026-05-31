import { describe, expect, it } from "vitest";

import { envelopeToSendRequest } from "../src/a2a-message.js";
import { buildCouncilRequest, signCouncilRequest } from "../src/council-wire.js";
import { AGENT_CARD_PATH, createA2AHandler, type A2ARequest } from "../src/handler.js";
import { createPeerRegistry } from "../src/peer-registry.js";
import { signEnvelope } from "../src/signing.js";
import { A2A_SIGNATURE_HEADER } from "../src/transport.js";

const SECRET = "peer-secret";
const registry = createPeerRegistry([{ id: "peer-a", secret: SECRET, url: "https://peer-a.test" }]);
const agentCard = { name: "muse", protocolVersion: "0.3.0" } as never;
const ENV = { MUSE_A2A_ENABLED: "true" };

const req = (method: string, path: string, body = "", headers: Record<string, string> = {}): A2ARequest =>
  ({ body, headers, method, path });
const knowHowBody = (kind: "skill" | "strategy" = "skill") => {
  const envelope = { content: "c", fromPeerId: "peer-a", kind, redacted: false };
  return { body: JSON.stringify(envelopeToSendRequest(envelope, "m", "r")), sig: signEnvelope(envelope, SECRET) };
};

function handler(extra: Record<string, unknown> = {}) {
  const deposited: unknown[] = [];
  const h = createA2AHandler({ agentCard, deposit: async (i) => { deposited.push(i); }, env: ENV, genId: () => "id", now: () => 1, registry, selfPeerId: "me", ...extra });
  return { deposited, h };
}

describe("createA2AHandler — off-by-default + discovery", () => {
  it("answers 403 to EVERYTHING when A2A is disabled (even agent-card discovery)", async () => {
    const h = createA2AHandler({ agentCard, deposit: async () => {}, env: {}, registry });
    expect((await h(req("GET", AGENT_CARD_PATH))).status).toBe(403);
    expect((await h(req("POST", "/"))).status).toBe(403);
  });

  it("serves the agent card on GET, stripping any query string, and 404s other GET paths", async () => {
    const { h } = handler();
    const card = await h(req("GET", `${AGENT_CARD_PATH}?v=1`));
    expect(card.status).toBe(200);
    expect(JSON.parse(card.body).name).toBe("muse");
    expect((await h(req("GET", "/something-else"))).status).toBe(404);
  });

  it("405s a method that is neither GET nor POST", async () => {
    const { h } = handler();
    expect((await h(req("DELETE", "/"))).status).toBe(405);
  });
});

describe("createA2AHandler — POST know-how (terminal ack, never a Task)", () => {
  it("quarantines a valid signed message, deposits it, and acks 200 (no compute triggered)", async () => {
    const { deposited, h } = handler();
    const { body, sig } = knowHowBody();
    const res = await h(req("POST", "/", body, { [A2A_SIGNATURE_HEADER]: sig }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).kind).toBe("message"); // a terminal Message, not a Task
    expect(JSON.parse(res.body).parts[0].text).toContain("quarantined");
    expect(deposited).toHaveLength(1);
  });

  it("acks 'rejected' (and deposits nothing) for a bad signature", async () => {
    const { deposited, h } = handler();
    const { body } = knowHowBody();
    const res = await h(req("POST", "/", body, { [A2A_SIGNATURE_HEADER]: "deadbeef" }));
    expect(JSON.parse(res.body).parts[0].text).toMatch(/^rejected/u);
    expect(deposited).toHaveLength(0);
  });
});

describe("createA2AHandler — council compute path (bounded, opt-in)", () => {
  const councilBody = JSON.stringify(buildCouncilRequest("peer-a", "what should we do?", "r"));
  const councilSig = signCouncilRequest("peer-a", "what should we do?", SECRET);

  it("contributes nothing (empty reasoning) when this Muse isn't participating (no councilReason)", async () => {
    const { h } = handler();
    const res = await h(req("POST", "/", councilBody, { [A2A_SIGNATURE_HEADER]: councilSig }));
    const parsed = JSON.parse(res.body);
    expect(parsed.kind).toBe("council-reasoning");
    expect(parsed.reasoning).toBe("");
  });

  it("runs the bounded reasoning step for a valid signed council request when participating", async () => {
    const { h } = handler({ councilReason: async (q: string) => `because ${q}` });
    const res = await h(req("POST", "/", councilBody, { [A2A_SIGNATURE_HEADER]: councilSig }));
    expect(JSON.parse(res.body).reasoning).toBe("because what should we do?");
  });

  it("refuses to compute (empty reasoning) on a council request with a bad signature, even when participating", async () => {
    let reasoned = false;
    const { h } = handler({ councilReason: async () => { reasoned = true; return "x"; } });
    const res = await h(req("POST", "/", councilBody, { [A2A_SIGNATURE_HEADER]: "bad" }));
    expect(JSON.parse(res.body).reasoning).toBe("");
    expect(reasoned).toBe(false); // a forged council request never triggers compute
  });
});
