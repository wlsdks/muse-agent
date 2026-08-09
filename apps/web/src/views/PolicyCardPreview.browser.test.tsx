import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ApiClient } from "../api/client.js";
import { I18nProvider } from "../i18n/index.js";
import { OwnerTaughtPolicyCard } from "./PolicyCardPreview.js";

const THREADS = [{
  id: "thread_trip",
  policy: { detail: "standard", nextStep: "direct" }
}] as const;

function learningQueue() {
  return {
    items: [{
      activation: "none",
      deliveryId: "delivery_trip",
      opportunityId: `learning_opportunity_${"a".repeat(64)}`,
      outcome: {
        outcome: "adjusted" as const,
        outcomeId: "outcome_trip",
        recordedAt: "2026-08-01T08:00:00.000Z"
      },
      requiredReview: {
        boundedDraft: true,
        explicitApproval: true,
        frozenReplayEvidence: true
      },
      schemaVersion: 1,
      scope: { threadId: "thread_trip" },
      sourceRun: {
        behaviorDigest: "b".repeat(64),
        completedAt: "2026-08-01T07:59:00.000Z",
        evidenceClass: "organic-production" as const,
        runId: "run_trip"
      },
      status: "review-required"
    }],
    limit: 20,
    status: "review-required" as const,
    total: 1,
    truncated: false
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

async function policyDigest(policy: Readonly<{
  readonly detail: "compact" | "standard";
  readonly nextStep: "contextual" | "direct" | "hidden";
  readonly suppression: "acknowledge-previous" | "none";
  readonly version: number;
}>): Promise<string> {
  return sha256Hex(JSON.stringify([
    "muse.continuity-policy.v1",
    policy.detail,
    policy.nextStep,
    policy.suppression,
    policy.version
  ]));
}

async function replayEvidenceCases() {
  const caseIds = [
    "desired-detail",
    "desired-next-step",
    "no-activation",
    "preserve-action-scope",
    "preserve-permission",
    "preserve-recipient",
    "preserve-retention",
    "preserve-source",
    "preserve-suppression",
    "thread-only-scope"
  ] as const;
  return Promise.all(caseIds.map(async (caseId, index) => {
    const inputHash = await sha256Hex(JSON.stringify({ caseId }));
    const receipt = async (
      variant: "baseline" | "challenger",
      passed: boolean
    ) => {
      const core = {
        caseId,
        evaluator: { id: "owner-taught-policy-contract", version: "1" },
        inputHash,
        observedAt: "2026-08-01T08:01:00.000Z",
        passed,
        schemaVersion: 1 as const,
        variant
      };
      return { ...core, evidenceHash: await sha256Hex(JSON.stringify(core)) };
    };
    return {
      baseline: await receipt("baseline", index !== 0),
      caseId,
      challenger: await receipt("challenger", true)
    };
  }));
}

async function renderedCard(
  locale: "en" | "ko",
  assessedPolicy: Readonly<{
    readonly detail: "compact" | "standard";
    readonly nextStep: "contextual" | "direct" | "hidden";
    readonly suppression: "acknowledge-previous" | "none";
    readonly version: number;
  }> = {
    detail: "standard",
    nextStep: "direct",
    suppression: "none",
    version: 1
  }
) {
  const korean = locale === "ko";
  const expectedBenefit = korean
    ? "이 스레드의 표시만 간결하게 합니다."
    : "Keep only this thread's display compact.";
  const expiresAt = "2026-08-08T08:01:00.000Z";
  const proposedAt = "2026-08-01T08:01:00.000Z";
  const proposedBehavior = korean
    ? "간결한 맥락과 함께 다음 단계를 표시합니다."
    : "Show compact context with a contextual next step.";
  const proposedChange = {
    detail: "compact" as const,
    kind: "thread-display" as const,
    nextStep: "contextual" as const
  };
  const [activeBehaviorDigestBefore, evidenceCases]
    = await Promise.all([
      policyDigest(assessedPolicy),
      replayEvidenceCases()
    ]);
  const controls = [
    ["apply", korean ? "별도 승인 흐름에서 적용" : "Apply in separate approval flow"],
    ["edit", korean ? "수정 사용 불가" : "Edit unavailable"],
    ["reject", korean ? "거절 사용 불가" : "Reject unavailable"],
    ["rollback", korean ? "적용 전 되돌리기 사용 불가" : "Rollback unavailable before application"],
    ["trial", korean ? "신뢰된 시험 사용 불가" : "Trusted trial unavailable"]
  ] as const;
  return {
    assessedPolicy,
    status: "rendered" as const,
    card: {
      assessedSnapshot: {
        currentWorldFreshness: false as const,
        freshness: "provider-head-matched-at-assessment"
      },
      boundary: { activation: "none" as const, approval: "none" as const, effect: "none" as const },
      controls: controls.map(([kind, label]) => ({
        approvalGranted: false,
        availability: "unavailable_in_preview",
        effectPerformed: false,
        kind,
        label,
        note: korean ? "이 제어는 미리보기에서 실행되지 않습니다." : "This control performs no effect in preview."
      })),
      evidence: {
        authoritativeExperience: {
          authority: "owner-explicit" as const,
          deliveryId: "delivery_trip",
          evidenceClass: "organic-production" as const,
          label: korean ? "실사용자 사용 결과" : "Owner-use outcome",
          outcome: "adjusted" as const,
          outcomeId: "outcome_trip",
          recordedAt: "2026-08-01T08:00:00.000Z",
          sourceRunId: "run_trip"
        },
        callerSuppliedReplayClaims: {
          aggregate: {},
          executionProvenanceVerified: false as const,
          label: korean
            ? "호출자 제공 replay 주장 — 실행 출처는 검증되지 않음"
            : "Caller-supplied replay claims — execution provenance not verified",
          recommendation: "hold",
          replayBundleId: "f".repeat(64),
          replayInputHash: "c".repeat(64),
          receiptHashes: [],
          validation: "structurally-validated-self-consistent-caller-claims"
        },
        graphExplanation: {
          assertionIds: ["assertion_delivery", "assertion_scope"],
          label: korean
            ? "평가 스냅샷에서 로컬로 파생한 AttuneGraph 관계 설명"
            : "AttuneGraph explanation locally derived from the assessed snapshot",
          observationReceiptId: "observation_trip",
          projectionVersion: "projection-1",
          provenance: "locally-derived-from-provider-head-matched-assessed-snapshot",
          providerAttested: false as const,
          sourceVersion: "source-1"
        }
      },
      proposal: {
        activeBehaviorDigestAfter: activeBehaviorDigestBefore,
        activeBehaviorDigestBefore,
        candidateId: "candidate_trip",
        expectedBenefit,
        expiresAt,
        previewId: `learning_preview_${"e".repeat(64)}`,
        proposedAt,
        proposedBehavior,
        proposedChange
      },
      scope: {
        kind: "thread-only" as const,
        sourceId: "muse.local-attunement",
        threadId: "thread_trip"
      },
      title: korean ? "Muse가 배운 점 — 검토 미리보기" : "What Muse learned — review preview"
    },
    review: {
      draft: {
        expectedBenefit,
        expiresAt,
        experienceId: `owner-taught:${learningQueue().items[0]!.opportunityId}`,
        proposedAt,
        proposedBehavior,
        proposedChange,
        scope: { kind: "thread-display" as const, threadId: "thread_trip" }
      },
      evidenceCases,
      opportunityId: learningQueue().items[0]!.opportunityId,
      previewId: `learning_preview_${"e".repeat(64)}`,
      replayInputHash: "c".repeat(64)
    }
  };
}

async function appliedReceipt(input: Readonly<{
  readonly activeBehaviorDigestAfter?: string;
  readonly policyAfter?: Readonly<{
    readonly detail: "compact" | "standard";
    readonly nextStep: "contextual" | "direct" | "hidden";
    readonly suppression: "acknowledge-previous" | "none";
    readonly version: number;
  }>;
  readonly policyBefore?: Readonly<{
    readonly detail: "compact" | "standard";
    readonly nextStep: "contextual" | "direct" | "hidden";
    readonly suppression: "acknowledge-previous" | "none";
    readonly version: number;
  }>;
}> = {}) {
  const policyBefore = input.policyBefore ?? {
    detail: "standard" as const,
    nextStep: "direct" as const,
    suppression: "none" as const,
    version: 1
  };
  const policyAfter = input.policyAfter ?? {
    detail: "compact" as const,
    nextStep: "contextual" as const,
    suppression: "none" as const,
    version: 2
  };
  const activeBehaviorDigestBefore = await policyDigest(policyBefore);
  const activeBehaviorDigestAfter = input.activeBehaviorDigestAfter
    ?? await policyDigest(policyAfter);
  const approvalCore = {
    activeBehaviorDigestBefore,
    approvedAt: "2026-08-01T08:02:00.000Z",
    authority: "owner-explicit" as const,
    candidateId: "candidate_trip",
    expiresAt: "2026-08-08T08:01:00.000Z",
    previewId: `learning_preview_${"e".repeat(64)}`,
    replayBundleId: "f".repeat(64),
    replayInputHash: "c".repeat(64),
    schemaVersion: 1 as const
  };
  const promotionCore = {
    activeBehaviorDigestAfter,
    activeBehaviorDigestBefore,
    appliedAt: "2026-08-01T08:03:00.000Z",
    approvedAt: approvalCore.approvedAt,
    authority: "owner-explicit" as const,
    candidateId: approvalCore.candidateId,
    policyAfter,
    policyBefore,
    promotionApplied: true,
    proposedBehavior: "Show compact context with a contextual next step.",
    proposedChange: {
      detail: "compact" as const,
      kind: "thread-display" as const,
      nextStep: "contextual" as const
    },
    replayInputHash: approvalCore.replayInputHash,
    schemaVersion: 2 as const,
    scope: { kind: "thread-display" as const, threadId: "thread_trip" }
  };
  const promotionIdentity = [
    promotionCore.candidateId,
    promotionCore.replayInputHash,
    promotionCore.activeBehaviorDigestBefore,
    promotionCore.activeBehaviorDigestAfter,
    promotionCore.scope.kind,
    promotionCore.scope.threadId,
    promotionCore.proposedBehavior,
    promotionCore.proposedChange,
    promotionCore.approvedAt,
    promotionCore.appliedAt
  ];
  return {
    approval: {
      ...approvalCore,
      approvalId: `learning_approval_${await sha256Hex(JSON.stringify(approvalCore))}`
    },
    promotion: {
      ...promotionCore,
      promotionId:
        `learning_promotion_${await sha256Hex(JSON.stringify(promotionIdentity))}`
    }
  };
}

async function renderPolicyCard(input: {
  readonly get?: (path: string) => Promise<unknown>;
  readonly post?: (path: string, body: unknown) => Promise<unknown>;
} = {}) {
  const get = vi.fn(input.get ?? (async () => learningQueue()));
  const post = vi.fn(input.post ?? (async (path: string) =>
    path.endsWith("/policy-card-apply") ? appliedReceipt() : renderedCard("en")));
  const client = { baseUrl: "http://policy-card.test", get, post } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <OwnerTaughtPolicyCard client={client} threads={THREADS} />
      </I18nProvider>
    </QueryClientProvider>
  );
  return { get, post, queryClient, screen };
}

async function teachCompactContext(screen: Awaited<ReturnType<typeof renderPolicyCard>>["screen"]) {
  await screen.getByRole("combobox", { name: "Context detail" }).selectOptions("compact");
  await screen.getByRole("combobox", { name: "Next-step presentation" }).selectOptions("contextual");
  await screen.getByRole("button", { name: "Preview Policy Card" }).click();
}

test("an organic opportunity becomes a truthful Policy Card only after explicit teaching", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const { post, screen } = await renderPolicyCard();

  await expect.element(screen.getByText("Owner-taught · organic")).toBeVisible();
  await expect.element(screen.getByRole("article")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Preview Policy Card" })).toBeDisabled();

  await teachCompactContext(screen);

  expect(post).toHaveBeenCalledWith(
    `/api/attunement/learning-opportunities/${learningQueue().items[0]!.opportunityId}/policy-card-preview`,
    { detail: "compact", locale: "en", nextStep: "contextual" }
  );
  const card = screen.getByRole("article", { name: "What Muse learned — review preview" });
  await expect.element(card).toBeVisible();
  await expect.element(card.getByText("standard + direct → compact + contextual", { exact: true })).toBeVisible();
  await expect.element(card.getByText(/organic-production · outcome adjusted · delivery delivery_trip · source run run_trip/u)).toBeVisible();
  await expect.element(card.getByText(/does not prove usefulness/u)).toBeVisible();
  await expect.element(card.getByText(/not provider-attested/u)).toBeVisible();
  await expect.element(card.getByText("Activation none · approval none · effect none", { exact: true })).toBeVisible();
  for (const label of [
    "Apply in separate approval flow",
    "Edit unavailable",
    "Reject unavailable",
    "Rollback unavailable before application",
    "Trusted trial unavailable"
  ]) {
    await expect.element(card.getByRole("button", { name: label })).toBeDisabled();
  }
  await expect.element(card.getByRole("button", { name: "Apply this exact reviewed policy" })).toBeEnabled();
  expect(post).toHaveBeenCalledTimes(1);
});

test("explicit owner approval applies the exact review binding", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const { post, screen } = await renderPolicyCard();

  await teachCompactContext(screen);
  await screen.getByRole("button", { name: "Apply this exact reviewed policy" }).click();

  expect(post).toHaveBeenNthCalledWith(
    2,
    `/api/attunement/learning-opportunities/${learningQueue().items[0]!.opportunityId}/policy-card-apply`,
    {
      confirm: true,
      draft: {
        expectedBenefit: "Keep only this thread's display compact.",
        expiresAt: "2026-08-08T08:01:00.000Z",
        experienceId: `owner-taught:${learningQueue().items[0]!.opportunityId}`,
        proposedAt: "2026-08-01T08:01:00.000Z",
        proposedBehavior: "Show compact context with a contextual next step.",
        proposedChange: {
          detail: "compact",
          kind: "thread-display",
          nextStep: "contextual"
        },
        scope: { kind: "thread-display", threadId: "thread_trip" }
      },
      evidenceCases: expect.arrayContaining([
        expect.objectContaining({
          baseline: expect.objectContaining({ variant: "baseline" }),
          caseId: "desired-detail",
          challenger: expect.objectContaining({ variant: "challenger" })
        })
      ]),
      previewId: `learning_preview_${"e".repeat(64)}`,
      replayInputHash: "c".repeat(64)
    }
  );
  const applyRequest = post.mock.calls[1]![1] as {
    readonly evidenceCases: readonly unknown[];
  };
  expect(applyRequest.evidenceCases).toHaveLength(10);
  await expect.element(screen.getByText(
    "Applied. Muse will use this bounded display policy for this thread.",
    { exact: true }
  )).toBeVisible();
  await expect.element(screen.getByText(
    "This preview has not approved or applied anything. The button above is the explicit owner confirmation; the other controls remain inactive.",
    { exact: true }
  )).not.toBeInTheDocument();
});

test("a malformed success response never becomes an applied policy", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const incomplete = await appliedReceipt();
  const { approvalId: _approvalId, ...incompleteApproval } = incomplete.approval;
  const { screen } = await renderPolicyCard({
    post: async (path) => path.endsWith("/policy-card-apply")
      ? { ...incomplete, approval: incompleteApproval }
      : renderedCard("en")
  });

  await teachCompactContext(screen);
  await screen.getByRole("button", { name: "Apply this exact reviewed policy" }).click();

  await expect.element(screen.getByRole("alert")).toHaveTextContent(
    "Muse could not verify that this reviewed policy was applied. Refresh before trying again."
  );
  await expect.element(screen.getByText(
    "Applied. Muse will use this bounded display policy for this thread.",
    { exact: true }
  )).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", {
    name: "Apply this exact reviewed policy"
  })).toBeEnabled();
});

test.each([
  ["an unknown suppression mode", async () => {
    const receipt = await appliedReceipt();
    return {
      ...receipt,
      promotion: {
        ...receipt.promotion,
        policyAfter: {
          ...receipt.promotion.policyAfter,
          suppression: "unknown"
        },
        policyBefore: {
          ...receipt.promotion.policyBefore,
          suppression: "unknown"
        }
      }
    };
  }],
  ["an application after approval expiry", async () => {
    const receipt = await appliedReceipt();
    return {
      ...receipt,
      promotion: {
        ...receipt.promotion,
        appliedAt: "2026-08-08T08:02:00.000Z"
      }
    };
  }],
  ["a forged approval identity", async () => {
    const receipt = await appliedReceipt();
    return {
      ...receipt,
      approval: {
        ...receipt.approval,
        approvalId: `learning_approval_${"0".repeat(64)}`
      }
    };
  }],
  ["a forged promotion identity", async () => {
    const receipt = await appliedReceipt();
    return {
      ...receipt,
      promotion: {
        ...receipt.promotion,
        promotionId: `learning_promotion_${"0".repeat(64)}`
      }
    };
  }],
  ["a self-consistent but differently versioned prior policy", async () => {
    return appliedReceipt({
      policyAfter: {
        detail: "compact",
        nextStep: "contextual",
        suppression: "none",
        version: 10
      },
      policyBefore: {
        detail: "standard",
        nextStep: "direct",
        suppression: "none",
        version: 9
      }
    });
  }],
  ["a forged after-policy digest", async () => {
    return appliedReceipt({ activeBehaviorDigestAfter: "0".repeat(64) });
  }]
] as const)("a complete receipt with %s never becomes an applied policy", async (
  _description,
  receipt
) => {
  window.localStorage.setItem("muse.lang", "en");
  const { screen } = await renderPolicyCard({
    post: async (path) => path.endsWith("/policy-card-apply")
      ? receipt()
      : renderedCard("en")
  });

  await teachCompactContext(screen);
  await screen.getByRole("button", {
    name: "Apply this exact reviewed policy"
  }).click();

  await expect.element(screen.getByRole("alert")).toHaveTextContent(
    "Muse could not verify that this reviewed policy was applied. Refresh before trying again."
  );
  await expect.element(screen.getByText(
    "Applied. Muse will use this bounded display policy for this thread.",
    { exact: true }
  )).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", {
    name: "Apply this exact reviewed policy"
  })).toBeEnabled();
});

test("a queue change removes the older review before it can target a new opportunity", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const rendered = await renderPolicyCard();
  await teachCompactContext(rendered.screen);

  const nextQueue = learningQueue();
  rendered.queryClient.setQueryData(
    ["attunement-learning-opportunities", "http://policy-card.test"],
    {
      ...nextQueue,
      items: [{
        ...nextQueue.items[0]!,
        opportunityId: `learning_opportunity_${"f".repeat(64)}`
      }]
    }
  );

  await expect.element(rendered.screen.getByRole("button", {
    name: "Apply this exact reviewed policy"
  })).not.toBeInTheDocument();
  expect(rendered.post).toHaveBeenCalledTimes(1);
});

test("the owner-taught request and rendered Policy Card follow the active Korean locale", async () => {
  window.localStorage.setItem("muse.lang", "ko");
  const { post, screen } = await renderPolicyCard({
    post: async () => renderedCard("ko")
  });

  await screen.getByRole("combobox", { name: "맥락 상세 수준" }).selectOptions("compact");
  await screen.getByRole("combobox", { name: "다음 단계 표시 방식" }).selectOptions("contextual");
  await screen.getByRole("button", { name: "Policy Card 미리보기" }).click();

  expect(post).toHaveBeenCalledWith(
    expect.stringContaining("/policy-card-preview"),
    { detail: "compact", locale: "ko", nextStep: "contextual" }
  );
  const card = screen.getByRole("article", { name: "Muse가 배운 점 — 검토 미리보기" });
  await expect.element(card.getByText("현재 → 제안 표시 규칙", { exact: true })).toBeVisible();
  await expect.element(card.getByText(/유용성을 증명하지 않으며/u)).toBeVisible();
  await expect.element(card.getByRole("button", { name: "신뢰된 시험 사용 불가" })).toBeDisabled();
});

test("the before value comes from the card assessment, not stale Continuity page state", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const { screen } = await renderPolicyCard({
    post: async () => renderedCard("en", {
      detail: "compact",
      nextStep: "hidden",
      suppression: "acknowledge-previous",
      version: 4
    })
  });

  await teachCompactContext(screen);

  const card = screen.getByRole("article", {
    name: "What Muse learned — review preview"
  });
  await expect.element(card.getByText(
    "compact + hidden → compact + contextual",
    { exact: true }
  )).toBeVisible();
  await expect.element(card.getByText(
    "standard + direct → compact + contextual",
    { exact: true }
  )).not.toBeInTheDocument();
});

test("held and unavailable preparation remain explicit and never render a card", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const post = vi.fn()
    .mockResolvedValueOnce({ reason: "contract-replay-unavailable", status: "held" })
    .mockResolvedValueOnce({ reason: "opportunity-not-found", status: "unavailable" });
  const rendered = await renderPolicyCard({ post });

  await teachCompactContext(rendered.screen);
  await expect.element(rendered.screen.getByText("Policy Card held: contract-replay-unavailable. Nothing was changed.", { exact: true })).toBeVisible();
  await expect.element(rendered.screen.getByRole("article")).not.toBeInTheDocument();

  await rendered.screen.getByRole("combobox", { name: "Next-step presentation" }).selectOptions("hidden");
  await rendered.screen.getByRole("button", { name: "Preview Policy Card" }).click();
  await expect.element(rendered.screen.getByText("Policy Card unavailable: opportunity-not-found. Nothing was changed.", { exact: true })).toBeVisible();
  await expect.element(rendered.screen.getByRole("article")).not.toBeInTheDocument();
});

test("empty, queue failure, and preview failure are distinct non-writing states", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const empty = await renderPolicyCard({
    get: async () => ({ items: [], status: "empty" })
  });
  await expect.element(empty.screen.getByText("No current organic learning opportunity needs review.", { exact: true })).toBeVisible();
  expect(empty.post).not.toHaveBeenCalled();

  const queueFailure = await renderPolicyCard({
    get: async () => Promise.reject(new Error("offline"))
  });
  await expect.element(queueFailure.screen.getByText(/The learning opportunity could not be loaded/u)).toBeVisible();
  expect(queueFailure.post).not.toHaveBeenCalled();

  const previewFailure = await renderPolicyCard({
    post: async () => Promise.reject(new Error("preview failed"))
  });
  await teachCompactContext(previewFailure.screen);
  await expect.element(previewFailure.screen.getByText("Muse could not prepare this Policy Card. Nothing was changed.", { exact: true })).toBeVisible();
  await expect.element(previewFailure.screen.getByRole("article")).not.toBeInTheDocument();
});
