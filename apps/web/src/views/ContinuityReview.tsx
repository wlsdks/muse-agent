import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AsyncBlock, Badge, Button, Card, Stat } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";

type Outcome = "used" | "adjusted" | "ignored" | "rejected";
type Kind = "life" | "work";
const OUTCOMES: readonly Outcome[] = ["used", "adjusted", "ignored", "rejected"];

interface KindEvaluation {
  readonly automationGate: { readonly reasons: readonly string[]; readonly status: "hold" | "manual-only" };
  readonly firstPacks: { readonly considered: number; readonly rejected: number; readonly used: number };
  readonly improvementGate: { readonly reason: string; readonly status: string };
  readonly outcomes: Record<Outcome, number>;
  readonly totalDeliveries: number;
  readonly withOutcome: number;
}

interface ReviewResponse {
  readonly deliveries: readonly {
    readonly evidenceRefs: readonly { readonly artifactId: string; readonly artifactType: string; readonly providerId: string; readonly role: string }[];
    readonly id: string;
    readonly openedAt: string;
    readonly outcome?: { readonly outcome: Outcome; readonly recordedAt: string };
    readonly runId?: string;
    readonly thread: { readonly id: string; readonly kind: Kind; readonly title: string };
  }[];
  readonly evaluation: KindEvaluation & { readonly byKind: Readonly<Record<Kind, KindEvaluation>> };
  readonly threads: readonly {
    readonly id: string;
    readonly kind: Kind;
    readonly linkCount: number;
    readonly policy: { readonly detail: string; readonly nextStep: string; readonly suppression: string; readonly version: number };
    readonly title: string;
  }[];
}

function rate(part: number, total: number): string {
  return total === 0 ? "-" : `${Math.round((part / total) * 100)}%`;
}

function kindLabel(kind: Kind): string {
  return kind === "life" ? "Life" : "Work";
}

function outcomeTone(outcome: Outcome | undefined): "ok" | "warn" | "err" | "neutral" {
  if (outcome === "used") return "ok";
  if (outcome === "rejected") return "err";
  if (outcome === "adjusted") return "warn";
  return "neutral";
}

function KindSummary({ kind, evaluation }: { readonly kind: Kind; readonly evaluation: KindEvaluation }) {
  const { t } = useI18n();
  const gateTone = evaluation.automationGate.status === "manual-only" ? "ok" : "warn";
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, justifyContent: "space-between" }}>
        <div>
          <div className="row-title">{kindLabel(kind)}</div>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>{evaluation.improvementGate.reason}</p>
        </div>
        <Badge tone={gateTone}>{evaluation.automationGate.status === "manual-only" ? t("continuity.manualOnly") : t("continuity.hold")}</Badge>
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 16 }}>
        <Stat label={t("continuity.deliveries")} value={evaluation.totalDeliveries} />
        <Stat label={t("continuity.feedback")} value={evaluation.withOutcome} />
        <Stat label={t("continuity.usedRate")} value={rate(evaluation.firstPacks.used, evaluation.firstPacks.considered)} />
        <Stat label={t("continuity.rejectedRate")} value={rate(evaluation.firstPacks.rejected, evaluation.firstPacks.considered)} />
      </div>
    </Card>
  );
}

/** Read-only review of explicit Continuity deliveries; it never resolves note bodies or changes outcomes. */
export function ContinuityReviewView({ client }: { readonly client: ApiClient }) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const review = useQuery({
    queryFn: () => client.get<ReviewResponse>("/api/attunement/review"),
    queryKey: ["attunement-review", client.baseUrl]
  });
  const outcome = useMutation({
    mutationFn: ({ deliveryId, value }: { readonly deliveryId: string; readonly value: Outcome }) =>
      client.post(`/api/attunement/deliveries/${encodeURIComponent(deliveryId)}/outcome`, { outcome: value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attunement-review", client.baseUrl] })
  });
  const data = review.data;

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.knowledge")}</p>
      <h1 className="page-title">{t("continuity.title")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>{t("continuity.subtitle")}</p>

      <AsyncBlock loading={review.isLoading} error={review.error} empty={false}>
        {data ? (
          <>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", marginTop: 16 }}>
              <KindSummary kind="life" evaluation={data.evaluation.byKind.life} />
              <KindSummary kind="work" evaluation={data.evaluation.byKind.work} />
            </div>

            <h2 className="page-title" style={{ fontSize: 20, marginTop: 32 }}>{t("continuity.threads")}</h2>
            {data.threads.length === 0 ? (
              <p className="muted" style={{ marginTop: 8 }}>{t("continuity.threadsEmpty")}</p>
            ) : (
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", marginTop: 12 }}>
                {data.threads.map((thread) => (
                  <Card key={thread.id}>
                    <div style={{ alignItems: "flex-start", display: "flex", gap: 8, justifyContent: "space-between" }}>
                      <div>
                        <div className="row-title">{thread.title}</div>
                        <div className="row-meta">{kindLabel(thread.kind)} · {t("continuity.links", { n: thread.linkCount })}</div>
                      </div>
                      <Badge tone="neutral">v{thread.policy.version}</Badge>
                    </div>
                    <div className="row-meta" style={{ marginTop: 10 }}>{thread.policy.detail} · {thread.policy.nextStep} · {thread.policy.suppression}</div>
                  </Card>
                ))}
              </div>
            )}

            <h2 className="page-title" style={{ fontSize: 20, marginTop: 32 }}>{t("continuity.recent")}</h2>
            {data.deliveries.length === 0 ? (
              <p className="muted" style={{ marginTop: 8 }}>{t("continuity.empty")}</p>
            ) : data.deliveries.map((delivery) => (
              <Card key={delivery.id}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12, justifyContent: "space-between" }}>
                  <div>
                    <div className="row-title">{delivery.thread.title}</div>
                    <div className="row-meta">{kindLabel(delivery.thread.kind)} · {new Date(delivery.openedAt).toLocaleString(locale)}</div>
                  </div>
                  <Badge tone={outcomeTone(delivery.outcome?.outcome)}>{delivery.outcome?.outcome ?? t("continuity.awaiting")}</Badge>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                  {delivery.evidenceRefs.map((ref) => <Badge key={`${ref.providerId}:${ref.artifactType}:${ref.artifactId}:${ref.role}`} tone="neutral">{ref.artifactType}:{ref.artifactId}</Badge>)}
                </div>
                {delivery.runId ? <div className="row-meta mono" style={{ marginTop: 10 }}>run {delivery.runId}</div> : null}
                {!delivery.outcome ? (
                  <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                    <span className="row-meta">{t("continuity.recordOutcome")}</span>
                    {OUTCOMES.map((value) => (
                      <Button key={value} disabled={outcome.isPending} size="sm" variant="ghost" onClick={() => outcome.mutate({ deliveryId: delivery.id, value })}>
                        {value}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </Card>
            ))}
            {outcome.error ? <p className="banner err" style={{ marginTop: 12 }}>{t("continuity.outcomeError")}</p> : null}
          </>
        ) : null}
      </AsyncBlock>
    </div>
  );
}
