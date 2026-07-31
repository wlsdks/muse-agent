import { request as httpRequest } from "node:http";

import type {
  ContinuityCapsulePreparationService,
  ContinuityCapsulePreparationServiceResult
} from "@muse/autoconfigure";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  parseContinuityCapsuleRequest,
  projectContinuityCapsuleResponse,
  registerContinuityCapsuleRoutes
} from "./continuity-capsule-routes.js";
import { buildServer } from "./server.js";

const THREAD_ID = "thread_capsule_api";

function server(
  preparation?: Pick<ContinuityCapsulePreparationService, "prepare">,
  authService?: object
) {
  const app = Fastify();
  registerContinuityCapsuleRoutes(app, {
    authService: authService as never,
    ...(preparation ? { preparation } : {})
  });
  return app;
}

function readyResult(
  overrides: Readonly<{
    currentNextStepSourceKey?: string;
    currentObservation?: "previous" | "current";
    previousNextStepSourceKey?: string;
    previousObservation?: "previous" | "current";
  }> = {}
): ContinuityCapsulePreparationServiceResult {
  return {
    schemaVersion: 1,
    status: "ready",
    evidenceInput: {
      sentinel: "PRIVATE_EVIDENCE_INPUT"
    },
    receipt: {
      sentinel: "PRIVATE_PREPARATION_RECEIPT"
    },
    manifest: {
      sentinel: "PRIVATE_MANIFEST"
    },
    presentation: {
      schemaVersion: 1,
      formatVersion: "evidence-bound-v2",
      locale: "en",
      verification: "citation-binding-verified",
      authority: {
        invocation: "runtime-assembly-request",
        automaticTiming: "not-performed",
        observation: "caller-declared-observation",
        preparation: "model-generated-proposal",
        citationBinding: "verified",
        entailment: "not-verified",
        expectedMinutes: "estimate",
        sourceFreshness: "not-proven",
        authenticatedWitness: "not-proven",
        currentWorldTruth: "not-granted",
        sourceCompleteness: "not-granted",
        actionAuthority: "not-granted"
      },
      thread: {
        textOrigin: "source-receipt-snapshot",
        id: "PRIVATE_THREAD_ID",
        title: "Prepare the quarterly review"
      },
      systemCopy: {
        textOrigin: "deterministic-system-copy",
        headline: "Continuity Capsule",
        whyShown: "Shown because you explicitly requested this Capsule.",
        timingCaveat: "Muse did not evaluate whether now was a good time.",
        resumeHeading: "Previously recorded next step",
        changeSummary: "One exact relation changed.",
        currentNextStepHeading: "Current observation's next step",
        supportHeading: "Supporting sources",
        preparedHeading: "Prepared work",
        sourceHeading: "Sources and integrity details",
        privacyNotice: "Local personal data. Source freshness is not proven.",
        actionBoundary: "Display only. No action will run."
      },
      resume: {
        observedAt: "2026-07-30T08:00:00.000Z",
        previousNextStepSourceKey:
          overrides.previousNextStepSourceKey ?? "previous-task",
        currentAvailability: "available"
      },
      changeSummary: {
        status: "complete",
        candidateCount: 1,
        answeredCount: 1,
        totalChanges: 1,
        namedChanges: 1,
        technicalOnlyChanges: 0,
        abstentionCount: 0
      },
      changes: [{
        assertionId: "PRIVATE_ASSERTION_ID",
        kind: "revised",
        predicate: "NEXT_STEP_FOR",
        category: "next-step",
        temporalBasis: "learned-after",
        epistemicClass: "observed",
        recordedAt: "2026-07-30T09:00:00.000Z",
        displayBinding: "named-source",
        endpointBindings: [],
        pathAssertionIds: ["PRIVATE_PATH_ID"],
        graphSourceKeys: ["PRIVATE_GRAPH_SOURCE_KEY"],
        graphSources: { total: 1, displayed: 1, omitted: 0 },
        systemCopy: {
          textOrigin: "deterministic-system-copy",
          relationLabel: "The next-step relation changed.",
          kindLabel: "Revised",
          temporalBasisLabel: "Learned after the previous observation",
          bindingLabel: "Named from an exact Source Receipt snapshot."
        }
      }],
      abstentions: [],
      currentNextStepSourceKey:
        overrides.currentNextStepSourceKey ?? "current-task",
      supportingEvidenceSourceKeys: ["current-task"],
      preparedWork: {
        textOrigin: "model-generated-proposal",
        kind: "draft",
        actionMode: "display-only",
        title: "Compare the changed decision",
        content: "Review the changed source before choosing.",
        expectedMinutes: 12,
        expectedMinutesSemantics: "estimate"
      },
      sourceDrawer: {
        dataClass: "local-personal-linkable",
        telemetrySafe: false,
        previousObservedAt: "2026-07-30T08:00:00.000Z",
        currentObservedAt: "2026-07-30T09:00:00.000Z",
        preparedAt: "2026-07-30T09:00:00.000Z",
        generatedAt: "2026-07-30T09:00:01.000Z",
        previousSourceObservationReceiptId: "PRIVATE_PREVIOUS_SOURCE_ID",
        previousGraphObservationReceiptId: "PRIVATE_PREVIOUS_GRAPH_ID",
        currentSourceObservationReceiptId: "PRIVATE_CURRENT_SOURCE_ID",
        currentGraphObservationReceiptId: "PRIVATE_CURRENT_GRAPH_ID",
        manifestId: "PRIVATE_MANIFEST_ID",
        preparationReceiptId: "PRIVATE_PREPARATION_ID",
        evidenceInputId: "PRIVATE_EVIDENCE_ID",
        changeResultId: "PRIVATE_CHANGE_ID",
        artifactSources: [{
          sourceKey: "previous-task",
          textOrigin: "source-receipt-snapshot",
          reference: {
            artifactType: "task",
            providerId: "PRIVATE_PROVIDER_ID",
            artifactId: "PRIVATE_ARTIFACT_ID"
          },
          status: "available",
          observation: overrides.previousObservation ?? "previous",
          title: "Compare three hotels",
          summary: "Choose one candidate."
        }, {
          sourceKey: "current-task",
          textOrigin: "source-receipt-snapshot",
          reference: {
            artifactType: "task",
            providerId: "PRIVATE_PROVIDER_ID",
            artifactId: "PRIVATE_CURRENT_ARTIFACT_ID"
          },
          status: "available",
          observation: overrides.currentObservation ?? "current",
          title: "Review the changed cancellation deadline",
          summary: "One saved option expires tomorrow."
        }],
        graphSources: {
          total: 1,
          displayed: 1,
          omitted: 0,
          items: [{
            sourceKey: "PRIVATE_GRAPH_SOURCE_KEY",
            reference: {
              type: "assertion",
              id: "PRIVATE_GRAPH_REFERENCE_ID"
            }
          }]
        }
      },
      presentationId: "PRIVATE_PRESENTATION_ID"
    }
  } as unknown as ContinuityCapsulePreparationServiceResult;
}

describe("Continuity Capsule API contract", () => {
  it("rejects auth and malformed inputs before service work", async () => {
    const prepare = vi.fn(async () => readyResult());
    const protectedApp = server({ prepare }, {});
    const unauthorized = await protectedApp.inject({
      method: "POST",
      url: `/api/attunement/threads/${THREAD_ID}/capsule/prepare`,
      payload: { locale: "en" }
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["cache-control"]).toBe("private, no-store");
    expect(prepare).not.toHaveBeenCalled();

    const app = server({ prepare });
    for (const [url, payload] of [
      ["/api/attunement/threads/not-a-thread/capsule/prepare", { locale: "en" }],
      [`/api/attunement/threads/${THREAD_ID}/capsule/prepare`, {}],
      [`/api/attunement/threads/${THREAD_ID}/capsule/prepare`, { locale: "fr" }],
      [`/api/attunement/threads/${THREAD_ID}/capsule/prepare`, { locale: "en", draft: "run it" }]
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url,
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(prepare).not.toHaveBeenCalled();

    const malformedJson = await app.inject({
      method: "POST",
      url: `/api/attunement/threads/${THREAD_ID}/capsule/prepare`,
      headers: { "content-type": "application/json" },
      payload: "{\"locale\":"
    });
    expect(malformedJson.statusCode).toBe(400);
    expect(malformedJson.headers["cache-control"]).toBe(
      "private, no-store"
    );

    const productionApp = buildServer({
      authService: {
        authenticateBearer: vi.fn(async () => undefined)
      } as never,
      continuityCapsulePreparation: { prepare },
      logger: false,
      requireAuth: true
    });
    const productionUnauthorized = await productionApp.inject({
      method: "POST",
      url: `/api/attunement/threads/${THREAD_ID}/capsule/prepare`,
      payload: { locale: "en" }
    });
    expect(productionUnauthorized.statusCode).toBe(401);
    expect(productionUnauthorized.headers["cache-control"]).toBe(
      "private, no-store"
    );
    expect(prepare).not.toHaveBeenCalled();
    await productionApp.close();
  });

  it("does not evaluate an accessor and accepts a null-prototype exact body", () => {
    let reads = 0;
    const hostile = Object.defineProperty({}, "locale", {
      enumerable: true,
      get() {
        reads += 1;
        return "en";
      }
    });
    expect(parseContinuityCapsuleRequest(THREAD_ID, hostile)).toEqual({
      errorMessage: "continuity capsule body must contain exactly locale"
    });
    expect(reads).toBe(0);

    const exact = Object.assign(Object.create(null) as object, {
      locale: "ko"
    });
    expect(parseContinuityCapsuleRequest(THREAD_ID, exact)).toEqual({
      locale: "ko"
    });
  });

  it("keeps expected states typed and invokes the service exactly once", async () => {
    const seeded: ContinuityCapsulePreparationServiceResult = {
      schemaVersion: 1,
      status: "seeded",
      state: "process-local-baseline-seeded",
      reason: "no-prior-process-local-baseline",
      baselineDurability: "process-local-only",
      authority: {
        canAssertCurrentWorldTruth: false,
        canAssertSourceCompleteness: false,
        canGrantActionAuthority: false
      }
    };
    let preparedInput:
      | Parameters<ContinuityCapsulePreparationService["prepare"]>[0]
      | undefined;
    const prepare = vi.fn(async (
      input: Parameters<
        ContinuityCapsulePreparationService["prepare"]
      >[0]
    ) => {
      preparedInput = input;
      return seeded;
    });
    const app = server({ prepare });
    const response = await app.inject({
      method: "POST",
      url: `/api/attunement/threads/${THREAD_ID}/capsule/prepare`,
      payload: { locale: "ko" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      status: "seeded",
      baselineDurability: "process-local-only"
    });
    expect(projectContinuityCapsuleResponse({
      schemaVersion: 1,
      status: "seeded",
      state: "durable-baseline-seeded",
      reason: "no-prior-durable-baseline",
      baselineDurability: "durable-local",
      authority: {
        canAssertCurrentWorldTruth: false,
        canAssertSourceCompleteness: false,
        canGrantActionAuthority: false
      }
    })).toEqual({
      schemaVersion: 1,
      status: "seeded",
      baselineDurability: "durable-local"
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(preparedInput).toMatchObject({
      locale: "ko",
      threadId: THREAD_ID,
      signal: expect.any(AbortSignal)
    });
    expect(preparedInput?.signal?.aborted).toBe(false);

    const absent = await server().inject({
      method: "POST",
      url: `/api/attunement/threads/${THREAD_ID}/capsule/prepare`,
      payload: { locale: "en" }
    });
    expect(absent.json()).toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "service-not-configured"
    });
  });

  it("whitelists the ready DTO and fails closed on missing or crossed bindings", async () => {
    const response = await server({
      prepare: async () => readyResult()
    }).inject({
      method: "POST",
      url: `/api/attunement/threads/${THREAD_ID}/capsule/prepare`,
      payload: { locale: "en" }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ready");
    expect(body.capsule.stoppedPoint.source.title).toBe(
      "Compare three hotels"
    );
    expect(body.capsule.nextStep.source.title).toBe(
      "Review the changed cancellation deadline"
    );
    expect(body.capsule.preparedWork).toMatchObject({
      expectedMinutes: 12,
      expectedMinutesSemantics: "estimate",
      textOrigin: "model-generated-proposal",
      entailment: "not-verified"
    });
    expect(body.capsule.disclosure).toMatchObject({
      authenticatedWitness: "not-proven",
      sourceFreshness: "not-proven",
      currentWorldTruth: "not-granted",
      sourceCompleteness: "not-granted",
      actionAuthority: "not-granted"
    });
    const serialized = response.body;
    for (const sentinel of [
      "PRIVATE_EVIDENCE_INPUT",
      "PRIVATE_PREPARATION_RECEIPT",
      "PRIVATE_MANIFEST",
      "PRIVATE_PRESENTATION_ID",
      "PRIVATE_ASSERTION_ID",
      "PRIVATE_PATH_ID",
      "PRIVATE_GRAPH_SOURCE_KEY",
      "PRIVATE_PROVIDER_ID",
      "PRIVATE_ARTIFACT_ID",
      "PRIVATE_THREAD_ID"
    ]) {
      expect(serialized).not.toContain(sentinel);
    }

    const missing = projectContinuityCapsuleResponse(
      readyResult({ currentNextStepSourceKey: "missing-source" })
    );
    expect(missing).toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "presentation-unavailable"
    });

    const crossed = projectContinuityCapsuleResponse(readyResult({
      currentObservation: "previous",
      previousObservation: "current"
    }));
    expect(crossed).toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "presentation-unavailable"
    });
  });

  it("collapses nested failure reasons and sanitizes unexpected errors", async () => {
    const cases: readonly [
      ContinuityCapsulePreparationServiceResult,
      string
    ][] = [
      [{
        schemaVersion: 1,
        status: "unavailable",
        reason: "resume-runtime-unavailable",
        runtimeReason: "current-evidence-invalid"
      }, "comparison-unavailable"],
      [{
        schemaVersion: 1,
        status: "unavailable",
        reason: "model-preparation-unavailable",
        preparationReason: "provider-output-invalid"
      }, "provider-unavailable"],
      [{
        schemaVersion: 1,
        status: "unavailable",
        reason: "model-preparation-unavailable",
        preparationReason: "provider-timeout"
      }, "provider-timeout"]
    ];
    for (const [result, reason] of cases) {
      expect(projectContinuityCapsuleResponse(result)).toEqual({
        schemaVersion: 1,
        status: "unavailable",
        reason
      });
    }

    const app = server({
      prepare: async () => {
        throw new Error("PRIVATE_DEPENDENCY_PATH");
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/attunement/threads/${THREAD_ID}/capsule/prepare`,
      payload: { locale: "en" }
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("PRIVATE_DEPENDENCY_PATH");
    expect(response.json()).toEqual({
      errorMessage: "continuity capsule preparation is unavailable"
    });
  });

  it("aborts the exact service signal on a real client disconnect", async () => {
    let resolveSignal!: (signal: AbortSignal) => void;
    const captured = new Promise<AbortSignal>((resolve) => {
      resolveSignal = resolve;
    });
    const app = server({
      prepare: ({ signal }) => new Promise((resolve) => {
        resolveSignal(signal!);
        signal!.addEventListener("abort", () => {
          resolve({
            schemaVersion: 1,
            status: "unavailable",
            reason: "model-preparation-unavailable",
            preparationReason: "provider-cancelled"
          });
        }, { once: true });
      })
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = httpRequest(
      `${address}/api/attunement/threads/${THREAD_ID}/capsule/prepare`,
      {
        method: "POST",
        headers: { "content-type": "application/json" }
      }
    );
    request.on("error", () => undefined);
    request.end(JSON.stringify({ locale: "en" }));
    const signal = await captured;
    request.destroy();
    await vi.waitFor(() => {
      expect(signal.aborted).toBe(true);
    });
    await app.close();
  });
});
