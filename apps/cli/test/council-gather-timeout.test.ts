/**
 * Assembled-path: gatherCouncil terminates when a peer's fetch hangs (MAST arXiv:2503.13657).
 * Validates that the per-peer timeout in requestCouncilReasoning makes Promise.all resolve.
 */
import { describe, expect, it } from "vitest";

import { requestCouncilReasoning } from "@muse/a2a";
import { gatherCouncil } from "../src/commands-swarm.js";

const ENV = { MUSE_A2A_ENABLED: "true" };
const SECRET = "test-secret";

function makePeer(id: string) {
  return { id, secret: SECRET, url: `https://${id}.example.com/a2a` };
}

/**
 * A fetch that NEVER settles unless its abort signal fires — the hung-peer
 * scenario. Guards on `init.signal` (not `init.signal!`) so that if the
 * production code stops passing the abort signal into fetch, the promise hangs
 * forever and the test hits its per-test timeout and FAILS — rather than a
 * synchronous TypeError falsely turning it green. This is what makes the
 * assembled-path test a real non-vacuity proof of the wiring.
 */
function hungFetch(_url: string, init: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    if (init.signal) {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }
  });
}

/** A fetch that resolves immediately with a valid council response. */
function fastFetch(_url: string, _init: RequestInit): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ kind: "council-reasoning", fromPeerId: "peerB", reasoning: "peer B reasoning" }), { status: 200 })
  );
}

describe("gatherCouncil — assembled-path termination with a hung peer", () => {
  it("completes and yields only the responsive peer's utterance; the hung peer produces null within its timeout", { timeout: 4000 }, async () => {
    const peerA = makePeer("peerA");
    const peerB = makePeer("peerB");

    const utterances = await gatherCouncil("what should we do?", {
      peers: [peerA, peerB],
      requestReasoning: async (peer, question) => {
        if (peer.id === "peerA") {
          // Route through the REAL requestCouncilReasoning with the hung fetch + short timeout.
          // The timeout fires, the abort signal rejects the hung promise, catch returns null.
          return requestCouncilReasoning({
            env: ENV,
            fetchImpl: hungFetch as unknown as typeof fetch,
            fromPeerId: "me",
            peer,
            question,
            timeoutMs: 30
          });
        }
        // peerB responds promptly.
        return requestCouncilReasoning({
          env: ENV,
          fetchImpl: fastFetch as unknown as typeof fetch,
          fromPeerId: "me",
          peer,
          question,
          timeoutMs: 5_000
        });
      },
      selfId: "me"
    });

    // The council completes (doesn't hang) and carries exactly peerB's utterance.
    expect(utterances).toHaveLength(1);
    expect(utterances[0]!.peerId).toBe("peerB");
    expect(utterances[0]!.reasoning).toBe("peer B reasoning");
  });
});
