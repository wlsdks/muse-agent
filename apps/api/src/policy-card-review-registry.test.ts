import Fastify from "fastify";
import { expect, it } from "vitest";

import type { PolicyCardReviewBinding } from "./policy-card-review-registry.js";

import { policyCardReviewRegistryFor } from "./policy-card-review-registry.js";

function binding(index: number): PolicyCardReviewBinding {
  return {
    draft: { detail: index },
    evidenceCases: [{ index }],
    opportunityId: `opportunity_${index}`,
    previewId: `preview_${index}`,
    replayInputHash: `hash_${index}`
  };
}

it("bounds issued reviews per server and consumes only the exact binding", async () => {
  const server = Fastify();
  const otherServer = Fastify();
  try {
    const registry = policyCardReviewRegistryFor(server);
    const issued = Array.from({ length: 21 }, (_, index) => binding(index));
    for (const review of issued) registry.record(review);

    expect(registry.matches(issued[0]!)).toBe(false);
    expect(registry.matches(issued[20]!)).toBe(true);
    expect(policyCardReviewRegistryFor(otherServer).matches(issued[20]!)).toBe(false);
    expect(registry.consume({ ...issued[20]!, draft: { detail: "tampered" } })).toBe(false);
    expect(registry.consume(issued[20]!)).toBe(true);
    expect(registry.matches(issued[20]!)).toBe(false);
  } finally {
    await Promise.all([server.close(), otherServer.close()]);
  }
});
