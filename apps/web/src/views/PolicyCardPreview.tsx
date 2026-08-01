import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { ReactNode } from "react";

import type { ApiClient } from "../api/client.js";
import { Badge, Button, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

type DetailChoice = "compact" | "standard";
type NextStepChoice = "contextual" | "direct" | "hidden";

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
    readonly expectedBenefit: string;
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

type PolicyCardPreviewResponse =
  | Readonly<{
      readonly assessedPolicy: {
        readonly detail: DetailChoice;
        readonly nextStep: NextStepChoice;
      };
      readonly card: PolicyCardDto;
      readonly status: "rendered";
    }>
  | Readonly<{ readonly reason: string; readonly status: "held" | "unavailable" }>;

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

  useEffect(() => {
    setDetail("");
    setNextStep("");
    preview.reset();
  }, [lang, opportunity?.opportunityId]);

  const clearPreview = () => preview.reset();
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
          ) : result?.status === "rendered" ? (
            <RenderedPolicyCard
              assessedPolicy={result.assessedPolicy}
              card={result.card}
            />
          ) : null}
        </>
      )}
    </Card>
  );
}

function RenderedPolicyCard({
  assessedPolicy,
  card
}: {
  readonly assessedPolicy: {
    readonly detail: DetailChoice;
    readonly nextStep: NextStepChoice;
  };
  readonly card: PolicyCardDto;
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
        <p className="banner warn" style={{ marginBottom: 0 }}>
          {t("continuity.policyCard.noWrite")}
        </p>
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
