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

function renderedCard(
  locale: "en" | "ko",
  assessedPolicy: Readonly<{
    readonly detail: "compact" | "standard";
    readonly nextStep: "contextual" | "direct" | "hidden";
  }> = { detail: "standard", nextStep: "direct" }
) {
  const korean = locale === "ko";
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
          replayBundleId: "bundle_trip",
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
        activeBehaviorDigestAfter: "d".repeat(64),
        activeBehaviorDigestBefore: "b".repeat(64),
        candidateId: "candidate_trip",
        expectedBenefit: korean ? "이 스레드의 표시만 간결하게 합니다." : "Keep only this thread's display compact.",
        expiresAt: "2026-08-08T08:00:00.000Z",
        previewId: `learning_preview_${"e".repeat(64)}`,
        proposedAt: "2026-08-01T08:01:00.000Z",
        proposedBehavior: korean ? "간결한 맥락과 함께 다음 단계를 표시합니다." : "Show compact context with a contextual next step.",
        proposedChange: {
          detail: "compact" as const,
          kind: "thread-display" as const,
          nextStep: "contextual" as const
        }
      },
      scope: {
        kind: "thread-only" as const,
        sourceId: "muse.local-attunement",
        threadId: "thread_trip"
      },
      title: korean ? "Muse가 배운 점 — 검토 미리보기" : "What Muse learned — review preview"
    }
  };
}

async function renderPolicyCard(input: {
  readonly get?: (path: string) => Promise<unknown>;
  readonly post?: (path: string, body: unknown) => Promise<unknown>;
} = {}) {
  const get = vi.fn(input.get ?? (async () => learningQueue()));
  const post = vi.fn(input.post ?? (async () => renderedCard("en")));
  const client = { baseUrl: "http://policy-card.test", get, post } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <OwnerTaughtPolicyCard client={client} threads={THREADS} />
      </I18nProvider>
    </QueryClientProvider>
  );
  return { get, post, screen };
}

async function teachCompactContext(screen: Awaited<ReturnType<typeof renderPolicyCard>>["screen"]) {
  await screen.getByRole("combobox", { name: "Context detail" }).selectOptions("compact");
  await screen.getByRole("combobox", { name: "Next-step presentation" }).selectOptions("contextual");
  await screen.getByRole("button", { name: "Preview Policy Card" }).click();
}

test("an organic opportunity becomes a truthful inert Policy Card only after explicit teaching", async () => {
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
  expect(post).toHaveBeenCalledTimes(1);
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
      nextStep: "hidden"
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
