import { describe, expect, it } from "vitest";

import {
  buildCouncilRequest,
  COUNCIL_METHOD,
  MAX_COUNCIL_REASONING_CHARS,
  parseCouncilRequest,
  parseCouncilResponse,
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
    // Same length as a real signature but non-hex: exercises the decode/compare
    // catch (timingSafeEqual throws on unequal buffer lengths) — must fail-closed.
    expect(verifyCouncilRequest("alice", "what should we do?", "z".repeat(sig.length), SECRET)).toBe(false);
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
    const { calls, fetchImpl } = recordingFetch(() => json({ kind: "council-reasoning", fromPeerId: "peer-p", reasoning: "because X" }));
    const out = await requestCouncilReasoning({ env: ENV, fetchImpl, fromPeerId: "me", peer, question: "what?" });
    expect(out).toBe("because X");
    expect(calls[0]!.url).toBe("https://peer/a2a");
    expect((calls[0]!.init.headers as Record<string, string>)["x-muse-a2a-signature"]).toBeTruthy();
    expect(JSON.parse(calls[0]!.init.body as string).method).toBe(COUNCIL_METHOD);
  });

  it("returns null for a non-OK response, a wrong kind, a non-string / blank reasoning, or a thrown fetch", async () => {
    const mk = (responder: () => Response) => requestCouncilReasoning({ env: ENV, fetchImpl: recordingFetch(responder).fetchImpl, fromPeerId: "me", peer, question: "q" });
    expect(await mk(() => json({ kind: "council-reasoning", reasoning: "x" }, 500))).toBeNull(); // non-OK
    expect(await mk(() => json({ kind: "other", fromPeerId: "p", reasoning: "x" }))).toBeNull(); // wrong kind
    expect(await mk(() => json({ kind: "council-reasoning", fromPeerId: "p", reasoning: "   " }))).toBeNull(); // blank reasoning
    expect(await mk(() => json({ kind: "council-reasoning", fromPeerId: "p" }))).toBeNull(); // missing reasoning
    expect(await requestCouncilReasoning({ env: ENV, fetchImpl: (async () => { throw new Error("net"); }) as unknown as typeof fetch, fromPeerId: "me", peer, question: "q" })).toBeNull();
  });

  it("truncates an over-long peer reasoning to MAX_COUNCIL_REASONING_CHARS", async () => {
    const overlong = "x".repeat(MAX_COUNCIL_REASONING_CHARS + 500);
    const { fetchImpl } = recordingFetch(() => json({ kind: "council-reasoning", fromPeerId: "bob", reasoning: overlong }));
    const out = await requestCouncilReasoning({ env: ENV, fetchImpl, fromPeerId: "me", peer, question: "q?" });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(MAX_COUNCIL_REASONING_CHARS);
  });
});

describe("parseCouncilResponse — accepting-side boundary", () => {
  it("round-trips a valid response unchanged", () => {
    expect(parseCouncilResponse({ kind: "council-reasoning", fromPeerId: "bob", reasoning: "because X" })).toEqual({
      kind: "council-reasoning",
      fromPeerId: "bob",
      reasoning: "because X"
    });
  });

  it("returns null for null / a string / a number", () => {
    expect(parseCouncilResponse(null)).toBeNull();
    expect(parseCouncilResponse("a string")).toBeNull();
    expect(parseCouncilResponse(42)).toBeNull();
  });

  it("returns null for a wrong kind", () => {
    expect(parseCouncilResponse({ kind: "other-kind", fromPeerId: "bob", reasoning: "r" })).toBeNull();
    expect(parseCouncilResponse({ fromPeerId: "bob", reasoning: "r" })).toBeNull();
  });

  it("returns null for missing or blank reasoning", () => {
    expect(parseCouncilResponse({ kind: "council-reasoning", fromPeerId: "bob" })).toBeNull();
    expect(parseCouncilResponse({ kind: "council-reasoning", fromPeerId: "bob", reasoning: "" })).toBeNull();
    expect(parseCouncilResponse({ kind: "council-reasoning", fromPeerId: "bob", reasoning: "   " })).toBeNull();
    expect(parseCouncilResponse({ kind: "council-reasoning", fromPeerId: "bob", reasoning: 123 })).toBeNull();
  });

  it("carries fromPeerId through (coerced to \"\" when absent/non-string) — NOT a rejection reason (the producer emits \"\" when selfPeerId is unset, and the caller discards it)", () => {
    expect(parseCouncilResponse({ kind: "council-reasoning", reasoning: "r" })).toEqual({ kind: "council-reasoning", fromPeerId: "", reasoning: "r" });
    expect(parseCouncilResponse({ kind: "council-reasoning", fromPeerId: "", reasoning: "r" })).toEqual({ kind: "council-reasoning", fromPeerId: "", reasoning: "r" });
    expect(parseCouncilResponse({ kind: "council-reasoning", fromPeerId: 7, reasoning: "r" })).toEqual({ kind: "council-reasoning", fromPeerId: "", reasoning: "r" });
    expect(parseCouncilResponse({ kind: "council-reasoning", fromPeerId: "alice", reasoning: "r" })?.fromPeerId).toBe("alice");
  });

  it("truncates an over-long reasoning to MAX_COUNCIL_REASONING_CHARS, preserving kind + fromPeerId", () => {
    const overlong = "x".repeat(MAX_COUNCIL_REASONING_CHARS + 500);
    const result = parseCouncilResponse({ kind: "council-reasoning", fromPeerId: "bob", reasoning: overlong });
    expect(result).not.toBeNull();
    expect(result!.reasoning.length).toBe(MAX_COUNCIL_REASONING_CHARS);
    expect(result!.kind).toBe("council-reasoning");
    expect(result!.fromPeerId).toBe("bob");
  });
});
