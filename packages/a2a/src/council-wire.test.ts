import { describe, expect, it } from "vitest";

import { buildMuseAgentCard } from "./agent-card.js";
import {
  buildCouncilRequest,
  parseCouncilRequest,
  requestCouncilReasoning,
  signCouncilRequest,
  verifyCouncilRequest
} from "./council-wire.js";
import { createA2AHandler, type A2ARequest } from "./handler.js";
import { createPeerRegistry } from "./peer-registry.js";

const SHARED = "k";
const registry = createPeerRegistry([{ id: "phone", secret: SHARED, url: "x" }]);

describe("council-wire — sign / parse / verify", () => {
  it("parseCouncilRequest accepts a council/reason JSON-RPC, rejects others", () => {
    expect(parseCouncilRequest(buildCouncilRequest("phone", "rent or buy?", "r"))).toEqual({ fromPeerId: "phone", question: "rent or buy?" });
    expect(parseCouncilRequest({ method: "message/send", params: {} })).toBeNull();
    expect(parseCouncilRequest({ method: "council/reason", params: { fromPeerId: "p", question: "  " } })).toBeNull();
    expect(parseCouncilRequest(null)).toBeNull();
  });

  it("verify accepts a good signature, rejects tampered question / wrong secret", () => {
    const sig = signCouncilRequest("phone", "rent or buy?", SHARED);
    expect(verifyCouncilRequest("phone", "rent or buy?", sig, SHARED)).toBe(true);
    expect(verifyCouncilRequest("phone", "buy a boat?", sig, SHARED)).toBe(false); // question changed
    expect(verifyCouncilRequest("phone", "rent or buy?", sig, "other")).toBe(false);
    expect(verifyCouncilRequest("phone", "rent or buy?", undefined, SHARED)).toBe(false);
  });
});

describe("handler council branch — bounded reasoning, opt-in", () => {
  const card = buildMuseAgentCard({ url: "http://127.0.0.1:4111/a2a" });
  const post = (body: unknown, sig?: string): A2ARequest => ({
    body: JSON.stringify(body),
    headers: sig ? { "x-muse-a2a-signature": sig } : {},
    method: "POST",
    path: "/"
  });
  const handler = (councilReason?: (q: string) => Promise<string>) => createA2AHandler({
    agentCard: card,
    deposit: async () => {},
    env: { MUSE_A2A_ENABLED: "true" },
    registry,
    selfPeerId: "laptop",
    ...(councilReason ? { councilReason } : {})
  });

  const req = buildCouncilRequest("phone", "rent or buy?", "r1");
  const sig = signCouncilRequest("phone", "rent or buy?", SHARED);

  it("a council-enabled Muse returns its reasoning for a signed, allowlisted request", async () => {
    const res = await handler(async (q) => `I reason about: ${q}`)(post(req, sig));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { kind: string; fromPeerId: string; reasoning: string };
    expect(body).toMatchObject({ fromPeerId: "laptop", kind: "council-reasoning" });
    expect(body.reasoning).toContain("rent or buy?");
  });

  it("a non-participant (no councilReason) returns empty reasoning, runs nothing", async () => {
    const res = await handler(undefined)(post(req, sig));
    expect(JSON.parse(res.body)).toMatchObject({ kind: "council-reasoning", reasoning: "" });
  });

  it("a bad signature / unknown peer gets empty reasoning — no compute", async () => {
    let ran = false;
    const h = handler(async () => { ran = true; return "x"; });
    expect(JSON.parse((await h(post(req, "deadbeef"))).body).reasoning).toBe("");
    expect(JSON.parse((await h(post(buildCouncilRequest("stranger", "rent or buy?", "r"), signCouncilRequest("stranger", "rent or buy?", SHARED)))).body).reasoning).toBe("");
    expect(ran).toBe(false);
  });
});

describe("requestCouncilReasoning — initiator side", () => {
  const peer = { id: "phone", secret: SHARED, url: "https://phone.test/a2a" };
  it("returns the peer's reasoning from a council-reasoning response", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ fromPeerId: "phone", kind: "council-reasoning", reasoning: "buy if long-term" }), { status: 200 })) as unknown as typeof fetch;
    expect(await requestCouncilReasoning({ env: { MUSE_A2A_ENABLED: "true" }, fetchImpl, fromPeerId: "laptop", peer, question: "rent or buy?" })).toBe("buy if long-term");
  });
  it("null when the swarm is off, on empty reasoning, or on error", async () => {
    const empty = (async () => new Response(JSON.stringify({ kind: "council-reasoning", reasoning: "" }), { status: 200 })) as unknown as typeof fetch;
    expect(await requestCouncilReasoning({ env: {}, fromPeerId: "laptop", peer, question: "q" })).toBeNull(); // off
    expect(await requestCouncilReasoning({ env: { MUSE_A2A_ENABLED: "true" }, fetchImpl: empty, fromPeerId: "laptop", peer, question: "q" })).toBeNull();
  });
});
