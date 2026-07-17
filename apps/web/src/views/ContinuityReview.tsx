import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

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
  readonly resetReceipts: readonly { readonly id: string; readonly resetPolicyVersion: number; readonly threadId: string; readonly undone: boolean }[];
  readonly reviewQueue: {
    readonly next?: {
      readonly deliveryId: string;
      readonly evidence: readonly {
        readonly artifact?: OpenedPackArtifact;
        readonly reference: { readonly artifactId: string; readonly artifactType: string; readonly providerId: string; readonly role: string };
        readonly status: "available" | "unavailable";
      }[];
      readonly openedAt: string;
      readonly thread: { readonly id: string; readonly kind: Kind; readonly title: string };
    };
    readonly progress: {
      readonly eligibleDeliveries: number;
      readonly remainingFeedback: number;
      readonly remainingPacks: number;
      readonly reviewedDeliveries: number;
      readonly target: number;
    };
  };
  readonly threads: readonly {
    readonly id: string;
    readonly kind: Kind;
    readonly linkCount: number;
    readonly links: readonly { readonly artifactId: string; readonly artifactType: string; readonly providerId: string; readonly role: string }[];
    readonly policy: { readonly detail: string; readonly nextStep: string; readonly suppression: string; readonly version: number };
    readonly title: string;
  }[];
}

interface OpenedPackArtifact {
  readonly artifactId: string;
  readonly artifactType: string;
  readonly providerId: string;
  readonly role: string;
  readonly summary?: string;
  readonly taskDueAt?: string;
  readonly taskDueState?: "due" | "overdue";
  readonly taskStatus?: "open" | "done";
  readonly taskTags?: readonly string[];
  readonly title: string;
}

export interface OpenedPack {
  readonly delivery: { readonly id: string; readonly runId?: string };
  readonly pack: {
    readonly evidence: readonly {
      readonly artifact?: OpenedPackArtifact;
      readonly reference: { readonly artifactId: string; readonly artifactType: string; readonly providerId: string; readonly role: string };
      readonly status: "available" | "unavailable";
    }[];
    readonly nextStep?: OpenedPackArtifact;
    readonly policy: { readonly nextStep: string };
    readonly thread: { readonly kind: Kind; readonly title: string };
  };
}

export function PendingReviewCard({
  disabled,
  onOutcome,
  reviewQueue
}: {
  readonly disabled: boolean;
  readonly onOutcome: (deliveryId: string, value: Outcome) => void;
  readonly reviewQueue: ReviewResponse["reviewQueue"];
}) {
  const { t } = useI18n();
  const { next, progress } = reviewQueue;
  return <Card>
    <div className="row-title">{t("continuity.reviewProgress", {
      eligible: progress.eligibleDeliveries,
      reviewed: progress.reviewedDeliveries,
      target: progress.target,
      waiting: progress.remainingFeedback
    })}</div>
    {!next
      ? <p className="row-meta" style={{ marginBottom: 0 }}>{t("continuity.reviewNone")}</p>
      : <>
          <div className="row-title" style={{ marginTop: 12 }}>{t("continuity.nextReview", { title: next.thread.title })}</div>
          <div className="row-meta">{kindLabel(next.thread.kind)} · {next.deliveryId}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            {next.evidence.length === 0 ? <div className="row-meta">{t("continuity.reviewNoEvidence")}</div> : null}
            {next.evidence.map((entry) => {
              const marker = artifactMarker(entry.reference);
              return <div className="row-meta" key={`${entry.reference.providerId}:${marker}:${entry.reference.role}`}>
                {entry.artifact ? `${entry.artifact.title} · ${marker}` : `${t("continuity.unavailable")} · ${marker}`}
              </div>;
            })}
          </div>
          <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
            <span className="row-meta">{t("continuity.recordOutcome")}</span>
            {OUTCOMES.map((value) => <Button
              ariaLabel={t("continuity.recordOutcomeFor", { id: next.deliveryId, outcome: value })}
              disabled={disabled}
              key={value}
              size="sm"
              variant="ghost"
              onClick={() => onOutcome(next.deliveryId, value)}
            >{value}</Button>)}
          </div>
        </>}
  </Card>;
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

function artifactMarker(reference: OpenedPack["pack"]["evidence"][number]["reference"]): string {
  return `${reference.artifactType}:${reference.artifactId}`;
}

/** Policy-aware Pack surface: hidden next-step artifacts expose only their exact safe marker. */
export function OpenedPackCard({ openedPack }: { readonly openedPack: OpenedPack }) {
  const { t } = useI18n();
  return <Card>
    <div className="row-title">{t("continuity.packTitle", { title: openedPack.pack.thread.title })}</div>
    <div className="row-meta">{kindLabel(openedPack.pack.thread.kind)} · {t("continuity.delivery", { id: openedPack.delivery.id })}</div>
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
      {openedPack.pack.evidence.map((entry) => {
        const marker = artifactMarker(entry.reference);
        const hidesArtifact = openedPack.pack.policy.nextStep === "hidden" && entry.reference.role === "next-step";
        if (entry.status === "unavailable" || hidesArtifact || !entry.artifact) {
          return <div className="row-meta" key={`${entry.reference.providerId}:${marker}:${entry.reference.role}`}>
            {entry.status === "unavailable" ? `${t("continuity.unavailable")} · ` : ""}{marker}
          </div>;
        }
        const artifact = entry.artifact;
        return <div key={`${entry.reference.providerId}:${marker}:${entry.reference.role}`}>
          <div className="row-meta">{artifact.title} · {marker}</div>
          {artifact.summary ? <div className="row-meta">{artifact.summary}</div> : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
            {artifact.taskStatus ? <Badge tone="neutral">{t(`continuity.taskStatus.${artifact.taskStatus}`)}</Badge> : null}
            {artifact.taskDueAt && artifact.taskDueState
              ? <Badge tone={artifact.taskDueState === "overdue" ? "warn" : "neutral"}>{t(`continuity.${artifact.taskDueState}`, { timestamp: artifact.taskDueAt })}</Badge>
              : null}
            {artifact.taskTags && artifact.taskTags.length > 0
              ? <Badge tone="neutral">{t("continuity.tags", { tags: artifact.taskTags.join(", ") })}</Badge>
              : null}
          </div>
        </div>;
      })}
    </div>
    {openedPack.pack.policy.nextStep !== "hidden" && openedPack.pack.nextStep
      ? <div className="row-meta" style={{ marginTop: 12 }}>{t("continuity.nextStep", { title: openedPack.pack.nextStep.title })}</div>
      : null}
  </Card>;
}

function LinkForm({ disabled, onLink }: { readonly disabled: boolean; readonly onLink: (input: { artifactId: string; artifactType: "task" | "note"; role: "context" | "next-step" }) => void }) {
  const { t } = useI18n();
  const [artifactId, setArtifactId] = useState("");
  const [artifactType, setArtifactType] = useState<"task" | "note">("task");
  const [role, setRole] = useState<"context" | "next-step">("context");
  return <form onSubmit={(event) => {
    event.preventDefault();
    if (artifactId.trim()) onLink({ artifactId: artifactId.trim(), artifactType, role });
  }} style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
    <input className="input" value={artifactId} onChange={(event) => setArtifactId(event.target.value)} placeholder={t("continuity.linkId")} aria-label={t("continuity.linkId")} />
    <select className="input" value={artifactType} onChange={(event) => {
      const next = event.target.value as "task" | "note";
      setArtifactType(next);
      if (next === "note") setRole("context");
    }} aria-label={t("continuity.linkType")}>
      <option value="task">task</option><option value="note">note</option>
    </select>
    <select className="input" value={role} onChange={(event) => setRole(event.target.value as "context" | "next-step")} aria-label={t("continuity.linkRole")}>
      <option value="context">context</option>{artifactType === "task" ? <option value="next-step">next-step</option> : null}
    </select>
    <Button disabled={disabled || artifactId.trim().length === 0} size="sm" type="submit">{t("continuity.link")}</Button>
  </form>;
}

/** Read-only review of explicit Continuity deliveries; it never resolves note bodies or changes outcomes. */
export function ContinuityReviewView({ client }: { readonly client: ApiClient }) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [newThreadKind, setNewThreadKind] = useState<Kind | undefined>();
  const [newThreadTitle, setNewThreadTitle] = useState("");
  const [openedPack, setOpenedPack] = useState<OpenedPack | undefined>();
  const review = useQuery({
    queryFn: () => client.get<ReviewResponse>("/api/attunement/review"),
    queryKey: ["attunement-review", client.baseUrl]
  });
  const outcome = useMutation({
    mutationFn: ({ deliveryId, value }: { readonly deliveryId: string; readonly value: Outcome }) =>
      client.post(`/api/attunement/deliveries/${encodeURIComponent(deliveryId)}/outcome`, { outcome: value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attunement-review", client.baseUrl] })
  });
  const thread = useMutation({
    mutationFn: ({ kind, title }: { readonly kind: Kind; readonly title: string }) =>
      client.post("/api/attunement/threads", { kind, title }),
    onSuccess: () => {
      setNewThreadKind(undefined);
      setNewThreadTitle("");
      return queryClient.invalidateQueries({ queryKey: ["attunement-review", client.baseUrl] });
    }
  });
  const reset = useMutation({
    mutationFn: (threadId: string) => client.post(`/api/attunement/threads/${encodeURIComponent(threadId)}/reset`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attunement-review", client.baseUrl] })
  });
  const undoReset = useMutation({
    mutationFn: ({ resetId, threadId }: { readonly resetId: string; readonly threadId: string }) =>
      client.post(`/api/attunement/threads/${encodeURIComponent(threadId)}/resets/${encodeURIComponent(resetId)}/undo`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attunement-review", client.baseUrl] })
  });
  const link = useMutation({
    mutationFn: ({ artifactId, artifactType, role, threadId }: { readonly artifactId: string; readonly artifactType: "task" | "note"; readonly role: "context" | "next-step"; readonly threadId: string }) =>
      client.post(`/api/attunement/threads/${encodeURIComponent(threadId)}/links`, { artifactId, artifactType, role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attunement-review", client.baseUrl] })
  });
  const continueThread = useMutation({
    mutationFn: (threadId: string) => client.post<OpenedPack>(`/api/attunement/threads/${encodeURIComponent(threadId)}/continue`),
    onSuccess: (result) => {
      setOpenedPack(result);
      return queryClient.invalidateQueries({ queryKey: ["attunement-review", client.baseUrl] });
    }
  });
  const unlink = useMutation({
    mutationFn: ({ artifactId, artifactType, threadId }: { readonly artifactId: string; readonly artifactType: "task" | "note"; readonly threadId: string }) =>
      client.post(`/api/attunement/threads/${encodeURIComponent(threadId)}/links/unlink`, { artifactId, artifactType }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attunement-review", client.baseUrl] })
  });
  const deleteThread = useMutation({
    mutationFn: (threadId: string) => client.post(`/api/attunement/threads/${encodeURIComponent(threadId)}/delete`),
    onSuccess: () => {
      setOpenedPack(undefined);
      return queryClient.invalidateQueries({ queryKey: ["attunement-review", client.baseUrl] });
    }
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
            {openedPack ? <OpenedPackCard openedPack={openedPack} /> : null}
            <PendingReviewCard
              disabled={outcome.isPending}
              onOutcome={(deliveryId, value) => {
                if (window.confirm(t("continuity.outcomeConfirm", { outcome: value }))) outcome.mutate({ deliveryId, value });
              }}
              reviewQueue={data.reviewQueue}
            />

            <h2 className="page-title" style={{ fontSize: 20, marginTop: 32 }}>{t("continuity.threads")}</h2>
            <Card>
              <form onSubmit={(event) => {
                event.preventDefault();
                if (newThreadKind) thread.mutate({ kind: newThreadKind, title: newThreadTitle.trim() });
              }}>
                <div className="row-title">{t("continuity.newThread")}</div>
                <p className="muted" style={{ margin: "4px 0 12px", fontSize: 13 }}>{t("continuity.newThreadHint")}</p>
                <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <input className="input" value={newThreadTitle} onChange={(event) => setNewThreadTitle(event.target.value)} placeholder={t("continuity.threadTitle")} />
                  {(["life", "work"] as const).map((kind) => (
                    <Button aria-pressed={newThreadKind === kind} key={kind} size="sm" type="button" variant={newThreadKind === kind ? "secondary" : "ghost"} onClick={() => setNewThreadKind(kind)}>
                      {kindLabel(kind)}
                    </Button>
                  ))}
                  <Button disabled={!newThreadKind || newThreadTitle.trim().length === 0 || thread.isPending} size="sm" type="submit">{t("continuity.createThread")}</Button>
                </div>
              </form>
            </Card>
            {data.threads.length === 0 ? (
              <p className="muted" style={{ marginTop: 8 }}>{t("continuity.threadsEmpty")}</p>
            ) : (
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", marginTop: 12 }}>
                {data.threads.map((thread) => (
                  <Card key={thread.id}>
                    {(() => {
                      const latestReset = data.resetReceipts.find((receipt) => receipt.threadId === thread.id && !receipt.undone);
                      const hasExternalSource = thread.links.some((source) => source.providerId !== "local");
                      return <>
                    <div style={{ alignItems: "flex-start", display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between" }}>
                      <div>
                        <div className="row-title">{thread.title}</div>
                        <div className="row-meta">{kindLabel(thread.kind)} · {t("continuity.links", { n: thread.linkCount })}</div>
                      </div>
                      <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 6 }}>
                        <Badge tone="neutral">v{thread.policy.version}</Badge>
                        <Button disabled={reset.isPending} size="sm" variant="ghost" onClick={() => {
                          if (window.confirm(t("continuity.resetConfirm", { title: thread.title }))) reset.mutate(thread.id);
                        }}>{t("continuity.reset")}</Button>
                        <Button disabled={continueThread.isPending || thread.linkCount === 0 || hasExternalSource} size="sm" variant="secondary" onClick={() => continueThread.mutate(thread.id)}>{t("continuity.openPack")}</Button>
                        <Button disabled={deleteThread.isPending} size="sm" variant="ghost" onClick={() => {
                          if (window.confirm(t("continuity.deleteConfirm", { title: thread.title }))) deleteThread.mutate(thread.id);
                        }}>{t("continuity.delete")}</Button>
                        {latestReset ? <Button disabled={undoReset.isPending} size="sm" variant="ghost" onClick={() => undoReset.mutate({ resetId: latestReset.id, threadId: thread.id })}>{t("continuity.undoReset")}</Button> : null}
                      </div>
                    </div>
                    <div className="row-meta" style={{ marginTop: 10 }}>{thread.policy.detail} · {thread.policy.nextStep} · {thread.policy.suppression}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                      {thread.links.map((source) => source.providerId === "local" ? <Button key={`${source.providerId}:${source.artifactType}:${source.artifactId}:${source.role}`} disabled={unlink.isPending} size="sm" variant="ghost" onClick={() => unlink.mutate({ artifactId: source.artifactId, artifactType: source.artifactType as "task" | "note", threadId: thread.id })}>{t("continuity.unlink", { id: `${source.artifactType}:${source.artifactId}` })}</Button> : <Badge key={`${source.providerId}:${source.artifactType}:${source.artifactId}:${source.role}`} tone="neutral">{source.artifactType}:{source.artifactId}</Badge>)}
                    </div>
                    <LinkForm disabled={link.isPending} onLink={(input) => link.mutate({ ...input, threadId: thread.id })} />
                    {hasExternalSource ? <div className="row-meta" style={{ marginTop: 8 }}>{t("continuity.externalCliOnly")}</div> : null}
                      </>;
                    })()}
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
                      <Button key={value} disabled={outcome.isPending} size="sm" variant="ghost" onClick={() => {
                        if (window.confirm(t("continuity.outcomeConfirm", { outcome: value }))) outcome.mutate({ deliveryId: delivery.id, value });
                      }}>
                        {value}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </Card>
            ))}
            {outcome.error ? <p className="banner err" style={{ marginTop: 12 }}>{t("continuity.outcomeError")}</p> : null}
            {thread.error ? <p className="banner err" style={{ marginTop: 12 }}>{t("continuity.threadError")}</p> : null}
            {reset.error ? <p className="banner err" style={{ marginTop: 12 }}>{t("continuity.resetError")}</p> : null}
            {undoReset.error ? <p className="banner err" style={{ marginTop: 12 }}>{t("continuity.undoResetError")}</p> : null}
            {link.error ? <p className="banner err" style={{ marginTop: 12 }}>{t("continuity.linkError")}</p> : null}
            {continueThread.error ? <p className="banner err" style={{ marginTop: 12 }}>{t("continuity.packError")}</p> : null}
            {unlink.error ? <p className="banner err" style={{ marginTop: 12 }}>{t("continuity.unlinkError")}</p> : null}
            {deleteThread.error ? <p className="banner err" style={{ marginTop: 12 }}>{t("continuity.deleteError")}</p> : null}
          </>
        ) : null}
      </AsyncBlock>
    </div>
  );
}
