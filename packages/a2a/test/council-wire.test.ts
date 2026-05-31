import { describe, expect, it } from "vitest";

import {
  buildCouncilRequest,
  COUNCIL_METHOD,
  parseCouncilRequest,
  requestCouncilReasoning,
  signCouncilRequest,
  verifyCouncilRequest
} from "../src/council-wire.js";

const SECRET = "peer-secret";
const peer = { id: "p", secret: SECRET, url: "https://peer/a2a" };
const ENV = { MUSE_A2A_ENABLED: "true" };

function recordingFetch(responder: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ init, url }); return responder(); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe("verifyCouncilRequest — HMAC of the council request", () => {
  const sig = signCouncilRequest("alice", "what should we do?", SECRET);
  it("verifies a correct signature and rejects a wrong secret / non-string / wrong-length one", () => {
    expect(verifyCouncilRequest("alice", "what should we do?", sig, SECRET)).toBe(true);
    expect(verifyCouncilRequest("alice", "what should we do?", sig, "other")).toBe(false);
    expect(verifyCouncilRequest("alice", "what should we do?", undefined, SECRET)).toBe(false);
    expect(verifyCouncilRequest("alice", "what should we do?", "deadbeef", SECRET)).toBe(false); // wrong length
  });
  it("rejects when the question or peer id differs from what was signed (tamper)", () => {
    expect(verifyCouncilRequest("alice", "DIFFERENT", sig, SECRET)).toBe(false);
    expect(verifyCouncilRequest("mallory", "what should we do?", sig, SECRET)).toBe(false);
  });
});

describe("parseCouncilRequest — extract a council request from a body", () => {
  const valid = buildCouncilRequest("alice", "what should we do?", "rpc-1");
  it("returns the fromPeerId + question for a well-formed request", () => {
    expect(parseCouncilRequest(valid)).toEqual({ fromPeerId: "alice", question: "what should we do?" });
  });
  it("returns null for a non-object, a wrong method, or missing params (each clause)", () => {
    expect(parseCouncilRequest(null)).toBeNull();
    expect(parseCouncilRequest("a string")).toBeNull();
    expect(parseCouncilRequest({ ...valid, method: "message/send" })).toBeNull();
    expect(parseCouncilRequest({ method: COUNCIL_METHOD })).toBeNull(); // no params
  });
  it("returns null for a non-string peer/question or a blank question (each clause)", () => {
    expect(parseCouncilRequest({ method: COUNCIL_METHOD, params: { fromPeerId: 1, question: "q" } })).toBeNull();
    expect(parseCouncilRequest({ method: COUNCIL_METHOD, params: { fromPeerId: "a", question: 2 } })).toBeNull();
    expect(parseCouncilRequest({ method: COUNCIL_METHOD, params: { fromPeerId: "a", question: "   " } })).toBeNull();
  });
});

describe("requestCouncilReasoning — the council initiator (outbound)", () => {
  it("returns null WITHOUT a request when A2A is disabled or the question is blank", async () => {
    const off = recordingFetch(() => json({}));
    expect(await requestCouncilReasoning({ env: {}, fetchImpl: off.fetchImpl, fromPeerId: "me", peer, question: "q" })).toBeNull();
    const blank = recordingFetch(() => json({}));
    expect(await requestCouncilReasoning({ env: ENV, fetchImpl: blank.fetchImpl, fromPeerId: "me", peer, question: "  " })).toBeNull();
    expect(off.calls).toHaveLength(0);
    expect(blank.calls).toHaveLength(0);
  });

  it("signs + POSTs the council request and returns the peer's reasoning on success", async () => {
    const { calls, fetchImpl } = recordingFetch(() => json({ kind: "council-reasoning", reasoning: "because X" }));
    const out = await requestCouncilReasoning({ env: ENV, fetchImpl, fromPeerId: "me", peer, question: "what?" });
    expect(out).toBe("because X");
    expect(calls[0]!.url).toBe("https://peer/a2a");
    expect((calls[0]!.init.headers as Record<string, string>)["x-muse-a2a-signature"]).toBeTruthy();
    expect(JSON.parse(calls[0]!.init.body as string).method).toBe(COUNCIL_METHOD);
  });

  it("returns null for a non-OK response, a wrong kind, a non-string / blank reasoning, or a thrown fetch", async () => {
    const mk = (responder: () => Response) => requestCouncilReasoning({ env: ENV, fetchImpl: recordingFetch(responder).fetchImpl, fromPeerId: "me", peer, question: "q" });
    expect(await mk(() => json({ kind: "council-reasoning", reasoning: "x" }, 500))).toBeNull(); // non-OK
    expect(await mk(() => json({ kind: "other", reasoning: "x" }))).toBeNull(); // wrong kind
    expect(await mk(() => json({ kind: "council-reasoning", reasoning: "   " }))).toBeNull(); // blank reasoning
    expect(await mk(() => json({ kind: "council-reasoning" }))).toBeNull(); // missing reasoning
    expect(await requestCouncilReasoning({ env: ENV, fetchImpl: (async () => { throw new Error("net"); }) as unknown as typeof fetch, fromPeerId: "me", peer, question: "q" })).toBeNull();
  });
});
