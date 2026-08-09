import { types as nodeTypes } from "node:util";

import type {
  OwnerTaughtPolicyCardPreviewInput,
  OwnerTaughtPolicyCardPreviewService
} from "@muse/autoconfigure";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import { policyCardReviewRegistryFor } from "./policy-card-review-registry.js";
import type { ServerOptions } from "./server.js";

const OPPORTUNITY_ID = /^learning_opportunity_[a-f0-9]{64}$/u;
const DETAIL = ["compact", "standard"] as const;
const NEXT_STEP = ["contextual", "direct", "hidden"] as const;
const LOCALE = ["en", "ko"] as const;

export interface PolicyCardRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly preview?: OwnerTaughtPolicyCardPreviewService;
}

type ParsedPolicyCardRequest = Omit<
  OwnerTaughtPolicyCardPreviewInput,
  "opportunityId"
>;

export function parseOwnerTaughtPolicyCardRequest(
  opportunityId: unknown,
  value: unknown
): ParsedPolicyCardRequest | Readonly<{ readonly errorMessage: string }> {
  if (typeof opportunityId !== "string" || !OPPORTUNITY_ID.test(opportunityId)) {
    return { errorMessage: "policy card opportunityId is invalid" };
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    return { errorMessage: "policy card request must be one plain object" };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { errorMessage: "policy card request must be one plain object" };
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = ["detail", "locale", "nextStep"] as const;
  if (
    keys.length !== expected.length
    || keys.some((key) =>
      typeof key !== "string"
      || !expected.includes(key as (typeof expected)[number])
      || !("value" in descriptors[key]!))
  ) {
    return { errorMessage: "policy card request has invalid fields" };
  }
  const detail = descriptors.detail?.value;
  const locale = descriptors.locale?.value;
  const nextStep = descriptors.nextStep?.value;
  if (
    typeof detail !== "string"
    || !DETAIL.includes(detail as (typeof DETAIL)[number])
    || typeof locale !== "string"
    || !LOCALE.includes(locale as (typeof LOCALE)[number])
    || typeof nextStep !== "string"
    || !NEXT_STEP.includes(nextStep as (typeof NEXT_STEP)[number])
  ) {
    return { errorMessage: "policy card request has invalid values" };
  }
  return {
    detail: detail as ParsedPolicyCardRequest["detail"],
    locale: locale as ParsedPolicyCardRequest["locale"],
    nextStep: nextStep as ParsedPolicyCardRequest["nextStep"]
  };
}

export function registerPolicyCardRoutes(
  server: FastifyInstance,
  gate: PolicyCardRoutesGate
): void {
  server.post<{
    readonly Body: unknown;
    readonly Params: { readonly opportunityId: string };
  }>(
    "/api/attunement/learning-opportunities/:opportunityId/policy-card-preview",
    {
      onRequest: async (_request, reply) => {
        reply.header("cache-control", "private, no-store");
      }
    },
    async (request, reply) => {
      if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
        return reply;
      }
      const parsed = parseOwnerTaughtPolicyCardRequest(
        request.params.opportunityId,
        request.body
      );
      if ("errorMessage" in parsed) {
        return reply.code(400).send(parsed);
      }
      if (!gate.preview) {
        return reply.code(503).send({
          reason: "service-not-configured",
          schemaVersion: 1,
          status: "unavailable"
        });
      }
      try {
        const result = await gate.preview.preview({
          ...parsed,
          opportunityId: request.params.opportunityId
        });
        if (result.status === "rendered") {
          policyCardReviewRegistryFor(server).record(result.review);
        }
        return result;
      } catch {
        return reply.code(503).send({
          reason: "service-failure",
          schemaVersion: 1,
          status: "unavailable"
        });
      }
    }
  );
}
