import type { A2AEnvelope } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { envelopeToSendRequest } from "./a2a-message.js";
import { buildMuseAgentCard } from "./agent-card.js";
import { AGENT_CARD_PATH, createA2AHandler, type A2ARequest } from "./handler.js";
import { createPeerRegistry } from "./peer-registry.js";
import type { QuarantineDepositInput } from "./receive-quarantine.js";
import { signEnvelope } from "./signing.js";
import { A2A_SIGNATURE_HEADER } from "./transport.js";

const SHARED = "k";
const registry = createPeerRegistry([{ id: "phone", secret: SHARED, url: "x" }]);
const card = buildMuseAgentCard({ url: "http://127.0.0.1:4111/a2a" });
const envelope: A2AEnvelope = { content: "set MTU 1380", fromPeerId: "phone", kind: "skill", redacted: false };
const wire = JSON.stringify(envelopeToSendRequest(envelope, "m", "r"));

function harness(enabled = true) {
  const deposited: QuarantineDepositInput[] = [];
  const handler = createA2AHandler({
    agentCard: card,
    deposit: async (i) => { deposited.push(i); },
    env: enabled ? { MUSE_A2A_ENABLED: "true" } : {},
    genId: () => "qid",
    now: () => 1_000,
    registry
  });
  return { deposited, handler };
}
const req = (over: Partial<A2ARequest>): A2ARequest => ({ body: "", headers: {}, method: "GET", path: "/", ...over });

describe("createA2AHandler — inbound A2A endpoint, inert by construction", () => {
  it("serves the Agent Card at the well-known path", async () => {
    const { handler } = harness();
    const res = await handler(req({ method: "GET", path: AGENT_CARD_PATH }));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { protocolVersion: string; capabilities: { extensions: { uri: string }[] } };
    expect(body.protocolVersion).toBe("1.0");
    expect(body.capabilities.extensions[0]!.uri).toMatch(/know-how-only/);
  });

  it("POST of valid signed know-how → 200 ack 'quarantined' + deposit", async () => {
    const { handler, deposited } = harness();
    const res = await handler(req({ body: wire, headers: { [A2A_SIGNATURE_HEADER]: signEnvelope(envelope, SHARED) }, method: "POST" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ kind: "message", role: "agent" });
    expect(JSON.parse(res.body).parts[0].text).toMatch(/quarantined/);
    expect(deposited).toHaveLength(1);
    expect(deposited[0]).toMatchObject({ fromPeerId: "phone", id: "qid", kind: "skill" });
  });

  it("POST with a bad signature → 200 ack 'rejected', deposits NOTHING", async () => {
    const { handler, deposited } = harness();
    const res = await handler(req({ body: wire, headers: { [A2A_SIGNATURE_HEADER]: "deadbeef" }, method: "POST" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).parts[0].text).toMatch(/rejected/);
    expect(deposited).toHaveLength(0);
  });

  it("a DISABLED Muse is 403 to everything — unreachable, even discovery", async () => {
    const { handler, deposited } = harness(false);
    expect((await handler(req({ method: "GET", path: AGENT_CARD_PATH }))).status).toBe(403);
    expect((await handler(req({ body: wire, headers: { [A2A_SIGNATURE_HEADER]: signEnvelope(envelope, SHARED) }, method: "POST" }))).status).toBe(403);
    expect(deposited).toHaveLength(0);
  });

  it("unknown path / method → 404 / 405", async () => {
    const { handler } = harness();
    expect((await handler(req({ method: "GET", path: "/secrets" }))).status).toBe(404);
    expect((await handler(req({ method: "DELETE", path: "/" }))).status).toBe(405);
  });
});
