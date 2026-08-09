import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { ReactNode } from "react";

import type { ApiClient } from "../api/client.js";
import { Badge, Button, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

type DetailChoice = "compact" | "standard";
type NextStepChoice = "contextual" | "direct" | "hidden";
type SuppressionChoice = "acknowledge-previous" | "none";

interface ContinuityPolicyReceipt {
  readonly detail: DetailChoice;
  readonly nextStep: NextStepChoice;
  readonly suppression: SuppressionChoice;
  readonly version: number;
}

interface LearningOpportunity {
  readonly deliveryId: string;
  readonly opportunityId: string;
  readonly outcome: {
    readonly outcome: "adjusted" | "ignored" | "rejected";
    readonly outcomeId: string;
    readonly recordedAt: string;
  };
  readonly scope: { readonly threadId: string };
  readonly sourceRun: {
    readonly completedAt: string;
    readonly evidenceClass: "organic-production";
    readonly runId: string;
  };
}

interface LearningOpportunityQueue {
  readonly items: readonly LearningOpportunity[];
  readonly status: "empty" | "review-required";
}

interface PolicyCardControl {
  readonly kind: "apply" | "edit" | "reject" | "rollback" | "trial";
  readonly label: string;
  readonly note: string;
}

interface PolicyCardDto {
  readonly assessedSnapshot: {
    readonly currentWorldFreshness: false;
    readonly freshness: string;
  };
  readonly boundary: {
    readonly activation: "none";
    readonly approval: "none";
    readonly effect: "none";
  };
  readonly controls: readonly PolicyCardControl[];
  readonly evidence: {
    readonly authoritativeExperience: {
      readonly authority: "owner-explicit";
      readonly deliveryId: string;
      readonly evidenceClass: "controlled" | "organic-production";
      readonly outcome: "adjusted" | "ignored" | "rejected";
      readonly outcomeId: string;
      readonly recordedAt: string;
      readonly sourceRunId: string;
    };
    readonly callerSuppliedReplayClaims: {
      readonly executionProvenanceVerified: false;
      readonly label: string;
      readonly recommendation: string;
      readonly replayBundleId: string;
      readonly replayInputHash: string;
      readonly validation: string;
    };
    readonly graphExplanation: {
      readonly assertionIds: readonly string[];
      readonly label: string;
      readonly provenance: string;
      readonly providerAttested: false;
    };
  };
  readonly proposal: {
    readonly activeBehaviorDigestAfter: string;
    readonly activeBehaviorDigestBefore: string;
    readonly candidateId: string;
    readonly expectedBenefit: string;
    readonly expiresAt: string;
    readonly previewId: string;
    readonly proposedAt: string;
    readonly proposedBehavior: string;
    readonly proposedChange: {
      readonly detail: DetailChoice;
      readonly kind: "thread-display";
      readonly nextStep: NextStepChoice;
    };
  };
  readonly scope: {
    readonly kind: "thread-only";
    readonly sourceId: string;
    readonly threadId: string;
  };
  readonly title: string;
}

interface PolicyCardReview {
  readonly draft: unknown;
  readonly evidenceCases: unknown;
  readonly opportunityId: string;
  readonly previewId: string;
  readonly replayInputHash: string;
}

interface PolicyCardApplyInput {
  readonly assessedPolicy: ContinuityPolicyReceipt;
  readonly card: PolicyCardDto;
  readonly review: PolicyCardReview;
}

type PolicyCardPreviewResponse =
  | Readonly<{
      readonly assessedPolicy: {
        readonly detail: DetailChoice;
        readonly nextStep: NextStepChoice;
        readonly suppression: SuppressionChoice;
        readonly version: number;
      };
      readonly card: PolicyCardDto;
      readonly review: PolicyCardReview;
      readonly status: "rendered";
    }>
  | Readonly<{ readonly reason: string; readonly status: "held" | "unavailable" }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[]
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length
    && keys.every((key) => typeof key === "string" && fields.includes(key));
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isPolicy(value: unknown): value is ContinuityPolicyReceipt {
  return isRecord(value)
    && hasExactFields(value, ["detail", "nextStep", "suppression", "version"])
    && (value.detail === "compact" || value.detail === "standard")
    && (value.nextStep === "contextual"
      || value.nextStep === "direct"
      || value.nextStep === "hidden")
    && (value.suppression === "none"
      || value.suppression === "acknowledge-previous")
    && Number.isSafeInteger(value.version)
    && Number(value.version) >= 0;
}

async function sha256Hex(value: string): Promise<string | undefined> {
  try {
    if (!globalThis.crypto?.subtle) return undefined;
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value)
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

function policyFingerprintInput(policy: ContinuityPolicyReceipt): string {
  return JSON.stringify([
    "muse.continuity-policy.v1",
    policy.detail,
    policy.nextStep,
    policy.suppression,
    policy.version
  ]);
}

function isReviewBoundToCard(
  card: PolicyCardDto,
  review: PolicyCardReview
): boolean {
  if (!isRecord(review.draft)
    || !hasExactFields(review.draft, [
      "expectedBenefit",
      "expiresAt",
      "experienceId",
      "proposedAt",
      "proposedBehavior",
      "proposedChange",
      "scope"
    ])
    || !isRecord(review.draft.proposedChange)
    || !hasExactFields(review.draft.proposedChange, ["detail", "kind", "nextStep"])
    || !isRecord(review.draft.scope)
    || !hasExactFields(review.draft.scope, ["kind", "threadId"])) {
    return false;
  }
  return review.draft.expectedBenefit === card.proposal.expectedBenefit
    && review.draft.expiresAt === card.proposal.expiresAt
    && review.draft.experienceId === `owner-taught:${review.opportunityId}`
    && review.draft.proposedAt === card.proposal.proposedAt
    && review.draft.proposedBehavior === card.proposal.proposedBehavior
    && review.draft.proposedChange.detail === card.proposal.proposedChange.detail
    && review.draft.proposedChange.kind === card.proposal.proposedChange.kind
    && review.draft.proposedChange.nextStep === card.proposal.proposedChange.nextStep
    && review.draft.scope.kind === "thread-display"
    && review.draft.scope.threadId === card.scope.threadId
    && review.previewId === card.proposal.previewId
    && review.replayInputHash
      === card.evidence.callerSuppliedReplayClaims.replayInputHash;
}

async function isExactPolicyCardApplyReceipt(
  value: unknown,
  input: PolicyCardApplyInput
): Promise<boolean> {
  if (!isRecord(value)
    || !hasExactFields(value, ["approval", "promotion"])
    || !isRecord(value.approval)
    || !isRecord(value.promotion)) {
    return false;
  }
  const approval = value.approval;
  const promotion = value.promotion;
  if (!hasExactFields(approval, [
    "activeBehaviorDigestBefore",
    "approvalId",
    "approvedAt",
    "authority",
    "candidateId",
    "expiresAt",
    "previewId",
    "replayBundleId",
    "replayInputHash",
    "schemaVersion"
  ])
    || !hasExactFields(promotion, [
      "activeBehaviorDigestAfter",
      "activeBehaviorDigestBefore",
      "appliedAt",
      "approvedAt",
      "authority",
      "candidateId",
      "promotionApplied",
      "promotionId",
      "policyAfter",
      "policyBefore",
      "proposedBehavior",
      "proposedChange",
      "replayInputHash",
      "schemaVersion",
      "scope"
    ])
    || !isPolicy(promotion.policyAfter)
    || !isPolicy(promotion.policyBefore)
    || !isRecord(promotion.proposedChange)
    || !hasExactFields(promotion.proposedChange, ["detail", "kind", "nextStep"])
    || !isRecord(promotion.scope)
    || !hasExactFields(promotion.scope, ["kind", "threadId"])) {
    return false;
  }
  if (!(approval.authority === "owner-explicit"
    && isReviewBoundToCard(input.card, input.review)
    && approval.activeBehaviorDigestBefore
      === input.card.proposal.activeBehaviorDigestBefore
    && typeof approval.approvalId === "string"
    && /^learning_approval_[a-f0-9]{64}$/u.test(approval.approvalId)
    && isCanonicalIso(approval.approvedAt)
    && isCanonicalIso(approval.expiresAt)
    && isCanonicalIso(input.card.proposal.proposedAt)
    && Date.parse(approval.approvedAt)
      >= Date.parse(input.card.proposal.proposedAt)
    && Date.parse(approval.approvedAt) < Date.parse(approval.expiresAt)
    && approval.candidateId === input.card.proposal.candidateId
    && approval.expiresAt === input.card.proposal.expiresAt
    && approval.previewId === input.review.previewId
    && approval.replayBundleId
      === input.card.evidence.callerSuppliedReplayClaims.replayBundleId
    && approval.replayInputHash === input.review.replayInputHash
    && approval.schemaVersion === 1
    && typeof promotion.activeBehaviorDigestAfter === "string"
    && /^[a-f0-9]{64}$/u.test(promotion.activeBehaviorDigestAfter)
    && promotion.activeBehaviorDigestAfter
      !== input.card.proposal.activeBehaviorDigestBefore
    && promotion.activeBehaviorDigestBefore
      === input.card.proposal.activeBehaviorDigestBefore
    && isCanonicalIso(promotion.appliedAt)
    && promotion.approvedAt === approval.approvedAt
    && Date.parse(promotion.appliedAt) >= Date.parse(approval.approvedAt)
    && Date.parse(promotion.appliedAt) < Date.parse(approval.expiresAt)
    && promotion.authority === "owner-explicit"
    && promotion.candidateId === input.card.proposal.candidateId
    && typeof promotion.promotionId === "string"
    && /^learning_promotion_[a-f0-9]{64}$/u.test(promotion.promotionId)
    && promotion.policyBefore.detail === input.assessedPolicy.detail
    && promotion.policyBefore.nextStep === input.assessedPolicy.nextStep
    && promotion.policyAfter.detail
      === input.card.proposal.proposedChange.detail
    && promotion.policyAfter.nextStep
      === input.card.proposal.proposedChange.nextStep
    && promotion.policyAfter.suppression === promotion.policyBefore.suppression
    && Number(promotion.policyAfter.version) > Number(promotion.policyBefore.version)
    && promotion.promotionApplied === true
    && promotion.proposedBehavior === input.card.proposal.proposedBehavior
    && promotion.proposedChange.detail
      === input.card.proposal.proposedChange.detail
    && promotion.proposedChange.kind === "thread-display"
    && promotion.proposedChange.nextStep
      === input.card.proposal.proposedChange.nextStep
    && promotion.replayInputHash === input.review.replayInputHash
    && promotion.schemaVersion === 2
    && promotion.scope.kind === "thread-display"
    && promotion.scope.threadId === input.card.scope.threadId)) {
    return false;
  }

  const approvalCore = {
    activeBehaviorDigestBefore: approval.activeBehaviorDigestBefore,
    approvedAt: approval.approvedAt,
    authority: approval.authority,
    candidateId: approval.candidateId,
    expiresAt: approval.expiresAt,
    previewId: approval.previewId,
    replayBundleId: approval.replayBundleId,
    replayInputHash: approval.replayInputHash,
    schemaVersion: approval.schemaVersion
  };
  const promotionIdentity = [
    promotion.candidateId,
    promotion.replayInputHash,
    promotion.activeBehaviorDigestBefore,
    promotion.activeBehaviorDigestAfter,
    promotion.scope.kind,
    promotion.scope.threadId,
    promotion.proposedBehavior,
    promotion.proposedChange,
    promotion.approvedAt,
    promotion.appliedAt
  ];
  const [policyBeforeDigest, policyAfterDigest, approvalId, promotionId] =
    await Promise.all([
      sha256Hex(policyFingerprintInput(promotion.policyBefore)),
      sha256Hex(policyFingerprintInput(promotion.policyAfter)),
      sha256Hex(JSON.stringify(approvalCore)),
      sha256Hex(JSON.stringify(promotionIdentity))
    ]);
  return policyBeforeDigest !== undefined
    && policyAfterDigest !== undefined
    && approvalId !== undefined
    && promotionId !== undefined
    && promotion.policyBefore.detail === input.assessedPolicy.detail
    && promotion.policyBefore.nextStep === input.assessedPolicy.nextStep
    && promotion.policyBefore.suppression === input.assessedPolicy.suppression
    && promotion.policyBefore.version === input.assessedPolicy.version
    && approval.activeBehaviorDigestBefore === policyBeforeDigest
    && promotion.activeBehaviorDigestBefore === policyBeforeDigest
    && promotion.activeBehaviorDigestAfter === policyAfterDigest
    && input.card.proposal.activeBehaviorDigestBefore === policyBeforeDigest
    && input.card.proposal.activeBehaviorDigestAfter
      === input.card.proposal.activeBehaviorDigestBefore
    && approval.approvalId === `learning_approval_${approvalId}`
    && promotion.promotionId === `learning_promotion_${promotionId}`;
}

export interface PolicyCardThreadPolicy {
  readonly id: string;
  readonly policy: {
    readonly detail: string;
    readonly nextStep: string;
  };
}

export function OwnerTaughtPolicyCard({
  client,
  threads
}: {
  readonly client: ApiClient;
  readonly threads: readonly PolicyCardThreadPolicy[];
}) {
  const { lang, t } = useI18n();
  const [detail, setDetail] = useState<DetailChoice | "">("");
  const [nextStep, setNextStep] = useState<NextStepChoice | "">("");
  const queue = useQuery({
    queryFn: () => client.get<LearningOpportunityQueue>(
      "/api/attunement/learning-opportunities"
    ),
    queryKey: ["attunement-learning-opportunities", client.baseUrl]
  });
  const firstOpportunity = Array.isArray(queue.data?.items)
    ? queue.data.items[0]
    : undefined;
  const opportunity = firstOpportunity?.sourceRun?.evidenceClass
    === "organic-production"
    ? firstOpportunity
    : undefined;
  const currentPolicy = threads.find((thread) =>
    thread.id === opportunity?.scope.threadId
  )?.policy;
  const preview = useMutation({
    mutationFn: (input: Readonly<{
      detail: DetailChoice;
      nextStep: NextStepChoice;
      opportunityId: string;
    }>) => client.post<PolicyCardPreviewResponse>(
      `/api/attunement/learning-opportunities/${encodeURIComponent(input.opportunityId)}/policy-card-preview`,
      { detail: input.detail, locale: lang, nextStep: input.nextStep }
    )
  });
  const apply = useMutation({
    mutationFn: async (input: PolicyCardApplyInput) => {
      const receipt = await client.post<unknown>(
        `/api/attunement/learning-opportunities/${encodeURIComponent(input.review.opportunityId)}/policy-card-apply`,
        {
          confirm: true,
          draft: input.review.draft,
          evidenceCases: input.review.evidenceCases,
          previewId: input.review.previewId,
          replayInputHash: input.review.replayInputHash
        }
      );
      if (!await isExactPolicyCardApplyReceipt(receipt, input)) {
        throw new Error("policy card apply receipt did not match the reviewed binding");
      }
      return receipt;
    }
  });

  useEffect(() => {
    setDetail("");
    setNextStep("");
    preview.reset();
    apply.reset();
  }, [lang, opportunity?.opportunityId]);

  const clearPreview = () => {
    preview.reset();
    apply.reset();
  };
  const result = preview.data;

  return (
    <Card title={t("continuity.policyCard.teachTitle")}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {t("continuity.policyCard.teachIntro")}
      </p>

      {queue.isLoading ? (
        <p aria-live="polite" className="row-meta" role="status">
          {t("continuity.policyCard.loading")}
        </p>
      ) : queue.isError ? (
        <p className="banner err" role="alert">
          {t("continuity.policyCard.loadError")}
        </p>
      ) : !opportunity ? (
        <p className="row-meta">{t("continuity.policyCard.empty")}</p>
      ) : !currentPolicy ? (
        <p className="banner warn" role="status">
          {t("continuity.policyCard.threadUnavailable")}
        </p>
      ) : (
        <>
          <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Badge tone="accent">{t("continuity.policyCard.ownerEvidence")}</Badge>
            <span className="row-meta">
              {t("continuity.policyCard.scope", { threadId: opportunity.scope.threadId })}
            </span>
          </div>
          <p className="row-meta" style={{ marginBottom: 12, marginTop: 8 }}>
            {t("continuity.policyCard.opportunityEvidence", {
              deliveryId: opportunity.deliveryId,
              outcome: opportunity.outcome.outcome,
              runId: opportunity.sourceRun.runId
            })}
          </p>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (detail && nextStep) {
                preview.mutate({
                  detail,
                  nextStep,
                  opportunityId: opportunity.opportunityId
                });
              }
            }}
          >
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
              <label className="row-meta">
                {t("continuity.policyCard.detailLabel")}
                <select
                  className="input"
                  style={{ marginTop: 6, width: "100%" }}
                  value={detail}
                  onChange={(event) => {
                    setDetail(event.currentTarget.value as DetailChoice | "");
                    clearPreview();
                  }}
                >
                  <option value="">{t("continuity.policyCard.choose")}</option>
                  <option value="standard">{t("continuity.policyCard.detail.standard")}</option>
                  <option value="compact">{t("continuity.policyCard.detail.compact")}</option>
                </select>
              </label>
              <label className="row-meta">
                {t("continuity.policyCard.nextStepLabel")}
                <select
                  className="input"
                  style={{ marginTop: 6, width: "100%" }}
                  value={nextStep}
                  onChange={(event) => {
                    setNextStep(event.currentTarget.value as NextStepChoice | "");
                    clearPreview();
                  }}
                >
                  <option value="">{t("continuity.policyCard.choose")}</option>
                  <option value="direct">{t("continuity.policyCard.nextStep.direct")}</option>
                  <option value="contextual">{t("continuity.policyCard.nextStep.contextual")}</option>
                  <option value="hidden">{t("continuity.policyCard.nextStep.hidden")}</option>
                </select>
              </label>
            </div>
            <Button
              disabled={!detail || !nextStep || preview.isPending}
              type="submit"
            >
              {preview.isPending
                ? t("continuity.policyCard.preparing")
                : t("continuity.policyCard.preview")}
            </Button>
          </form>

          {preview.isError ? (
            <p className="banner err" role="alert">
              {t("continuity.policyCard.previewError")}
            </p>
          ) : result?.status === "held" ? (
            <p className="banner warn" role="status">
              {t("continuity.policyCard.held", { reason: result.reason })}
            </p>
          ) : result?.status === "unavailable" ? (
            <p className="banner warn" role="status">
              {t("continuity.policyCard.unavailable", { reason: result.reason })}
            </p>
          ) : result?.status === "rendered"
            && result.review.opportunityId === opportunity.opportunityId
            && isReviewBoundToCard(result.card, result.review) ? (
            <RenderedPolicyCard
              applyError={apply.error}
              applyPending={apply.isPending}
              applied={apply.isSuccess}
              assessedPolicy={result.assessedPolicy}
              card={result.card}
              onApply={() => apply.mutate({
                assessedPolicy: result.assessedPolicy,
                card: result.card,
                review: result.review
              })}
            />
          ) : null}
        </>
      )}
    </Card>
  );
}

function RenderedPolicyCard({
  applyError,
  applyPending,
  applied,
  assessedPolicy,
  card,
  onApply
}: {
  readonly applyError: Error | null;
  readonly applyPending: boolean;
  readonly applied: boolean;
  readonly assessedPolicy: {
    readonly detail: DetailChoice;
    readonly nextStep: NextStepChoice;
  };
  readonly card: PolicyCardDto;
  readonly onApply: () => void;
}) {
  const { t } = useI18n();
  const replay = card.evidence.callerSuppliedReplayClaims;
  const graph = card.evidence.graphExplanation;
  const experience = card.evidence.authoritativeExperience;

  return (
    <article aria-label={card.title} style={{ marginTop: 16 }}>
      <Card title={card.title}>
        <p className="row-meta" style={{ marginTop: 0 }}>
          {t("continuity.policyCard.exactScope", {
            sourceId: card.scope.sourceId,
            threadId: card.scope.threadId
          })}
        </p>
        <div className="row-title" style={{ marginTop: 12 }}>
          {t("continuity.policyCard.beforeAfter")}
        </div>
        <p className="row-meta">
          {assessedPolicy.detail} + {assessedPolicy.nextStep} → {card.proposal.proposedChange.detail} + {card.proposal.proposedChange.nextStep}
        </p>
        <p>{card.proposal.proposedBehavior}</p>
        <p className="row-meta">{card.proposal.expectedBenefit}</p>

        <EvidenceSection title={t("continuity.policyCard.authoritativeEvidence")}>
          <p className="row-meta">
            {t("continuity.policyCard.authoritativeEvidenceLine", {
              deliveryId: experience.deliveryId,
              evidenceClass: experience.evidenceClass,
              outcome: experience.outcome,
              runId: experience.sourceRunId
            })}
          </p>
        </EvidenceSection>

        <EvidenceSection title={t("continuity.policyCard.replayEvidence")}>
          <p className="row-meta">{replay.label}</p>
          <p className="row-meta">
            {t("continuity.policyCard.replayResult", {
              recommendation: replay.recommendation,
              validation: replay.validation
            })}
          </p>
          <p className="banner warn" style={{ marginBottom: 0 }}>
            {t("continuity.policyCard.replayLimitation")}
          </p>
        </EvidenceSection>

        <EvidenceSection title={t("continuity.policyCard.graphEvidence")}>
          <p className="row-meta">{graph.label}</p>
          <p className="row-meta">
            {t("continuity.policyCard.graphResult", {
              assertions: graph.assertionIds.length,
              provenance: graph.provenance
            })}
          </p>
          <p className="row-meta">{t("continuity.policyCard.graphLimitation")}</p>
        </EvidenceSection>

        <EvidenceSection title={t("continuity.policyCard.boundaries")}>
          <p className="row-meta">
            {t("continuity.policyCard.boundaryLine", {
              activation: card.boundary.activation,
              approval: card.boundary.approval,
              effect: card.boundary.effect
            })}
          </p>
          <p className="row-meta">{card.assessedSnapshot.freshness}</p>
          <p className="row-meta">{t("continuity.policyCard.currentWorldLimitation")}</p>
        </EvidenceSection>

        <section
          aria-label={t("continuity.policyCard.application")}
          style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 12 }}
        >
          <div className="row-title">{t("continuity.policyCard.application")}</div>
          <p className="row-meta">{t("continuity.policyCard.applicationNote")}</p>
          {applyError ? (
            <p className="banner err" role="alert">
              {t("continuity.policyCard.applyFailed")}
            </p>
          ) : applied ? (
            <p className="banner ok" role="status">
              {t("continuity.policyCard.applied")}
            </p>
          ) : null}
          <Button
            disabled={applyPending || applied}
            onClick={onApply}
            type="button"
          >
            {applyPending
              ? t("continuity.policyCard.applying")
              : applied
                ? t("continuity.policyCard.appliedButton")
                : t("continuity.policyCard.apply")}
          </Button>
        </section>

        <div className="row-title" style={{ marginTop: 14 }}>
          {t("continuity.policyCard.controls")}
        </div>
        <p className="row-meta">{t("continuity.policyCard.controlsInert")}</p>
        <div style={{ display: "grid", gap: 8 }}>
          {card.controls.map((control) => (
            <div
              key={control.kind}
              style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}
            >
              <Button ariaLabel={control.label} disabled size="sm" variant="ghost">
                {control.label}
              </Button>
              <span className="row-meta">{control.note}</span>
            </div>
          ))}
        </div>
        {applied ? null : (
          <p className="banner warn" style={{ marginBottom: 0 }}>
            {t("continuity.policyCard.noWrite")}
          </p>
        )}
      </Card>
    </article>
  );
}

function EvidenceSection({
  children,
  title
}: {
  readonly children: ReactNode;
  readonly title: string;
}) {
  return (
    <section style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 12 }}>
      <div className="row-title">{title}</div>
      {children}
    </section>
  );
}
