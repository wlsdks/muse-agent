import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Badge, Button } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { ContinuityNudge } from "./continuity-nudge.js";

export type ContinuityCapsuleUnavailableReason =
  | "service-not-configured"
  | "invalid-request"
  | "thread-not-found"
  | "unsupported-source-class"
  | "source-unavailable"
  | "busy"
  | "capacity"
  | "model-not-configured"
  | "comparison-unavailable"
  | "provider-unavailable"
  | "provider-timeout"
  | "preparation-unavailable"
  | "presentation-unavailable";

export interface ContinuityCapsuleDisplaySource {
  readonly observation: "previous" | "current";
  readonly status: "available" | "unavailable";
  readonly title?: string;
  readonly summary?: string;
}

export type ContinuityCapsulePrepareResponse =
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "seeded";
      readonly baselineDurability:
        | "durable-local"
        | "process-local-only";
    }>
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "unavailable";
      readonly reason: ContinuityCapsuleUnavailableReason;
    }>
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "ready";
      readonly capsule: {
        readonly locale: "en" | "ko";
        readonly headline: string;
        readonly threadTitle: string;
        readonly timingCaveat: string;
        readonly stoppedPoint: {
          readonly heading: string;
          readonly observedAt: string;
          readonly currentAvailability: "available" | "unavailable";
          readonly source: ContinuityCapsuleDisplaySource;
        };
        readonly changes: {
          readonly status: "complete" | "partial" | "no-change" | "abstained";
          readonly summary: string;
          readonly items: readonly {
            readonly relationLabel: string;
            readonly kindLabel: string;
            readonly bindingLabel: string;
          }[];
          readonly abstentions: readonly {
            readonly label: string;
            readonly affectedCount: number;
            readonly affectedCountUnit: "assertions" | "candidates";
          }[];
        };
        readonly nextStep: {
          readonly heading: string;
          readonly source: ContinuityCapsuleDisplaySource;
        };
        readonly preparedWork: {
          readonly heading: string;
          readonly title: string;
          readonly content: string;
          readonly expectedMinutes: number;
          readonly expectedMinutesSemantics: "estimate";
          readonly actionBoundary: string;
          readonly textOrigin: "model-generated-proposal";
          readonly entailment: "not-verified";
        };
        readonly disclosure: {
          readonly heading: string;
          readonly whyShown: string;
          readonly privacyNotice: string;
          readonly previousObservedAt: string;
          readonly currentObservedAt: string;
          readonly preparedAt: string;
          readonly generatedAt: string;
          readonly verification: "citation-binding-verified";
          readonly authenticatedWitness: "not-proven";
          readonly sourceFreshness: "not-proven";
          readonly currentWorldTruth: "not-granted";
          readonly sourceCompleteness: "not-granted";
          readonly actionAuthority: "not-granted";
          readonly sources: readonly ContinuityCapsuleDisplaySource[];
          readonly graphSources: {
            readonly total: number;
            readonly displayed: number;
            readonly omitted: number;
          };
        };
      };
    }>;

function sourceTitle(
  source: ContinuityCapsuleDisplaySource,
  fallback: string
): string {
  return source.title?.trim() || fallback;
}

type IntegrityState =
  | "citation-binding-verified"
  | "not-verified"
  | "not-proven"
  | "not-granted";

function integrityStateKey(
  state: IntegrityState
):
  | "chat.continuityCapsule.integrity.state.verified"
  | "chat.continuityCapsule.integrity.state.notVerified"
  | "chat.continuityCapsule.integrity.state.notProven"
  | "chat.continuityCapsule.integrity.state.notGranted" {
  switch (state) {
    case "citation-binding-verified":
      return "chat.continuityCapsule.integrity.state.verified";
    case "not-verified":
      return "chat.continuityCapsule.integrity.state.notVerified";
    case "not-proven":
      return "chat.continuityCapsule.integrity.state.notProven";
    case "not-granted":
      return "chat.continuityCapsule.integrity.state.notGranted";
  }
}

function SourceSnapshot({
  source,
  fallbackTitle,
  fallbackSummary,
  availableLabel,
  unavailableLabel
}: {
  readonly source: ContinuityCapsuleDisplaySource;
  readonly fallbackTitle: string;
  readonly fallbackSummary: string;
  readonly availableLabel: string;
  readonly unavailableLabel: string;
}) {
  return (
    <div className="continuity-capsule-source">
      <div className="row-title">
        {sourceTitle(source, fallbackTitle)}
      </div>
      <div className="row-meta">
        {source.status === "available"
          ? availableLabel
          : unavailableLabel}
      </div>
      <p>{source.summary?.trim() || fallbackSummary}</p>
    </div>
  );
}

function ReadyCapsule({
  response,
  onContinue,
  onDismiss
}: {
  readonly response: Extract<
    ContinuityCapsulePrepareResponse,
    { readonly status: "ready" }
  >;
  readonly onContinue: () => void;
  readonly onDismiss: () => void;
}) {
  const { capsule } = response;
  const { t } = useI18n();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <article
      className="continuity-capsule-card"
      aria-labelledby="continuity-capsule-heading"
    >
      <header className="continuity-capsule-header">
        <div>
          <div className="continuity-capsule-kicker">
            {capsule.threadTitle}
          </div>
          <h2
            id="continuity-capsule-heading"
            ref={headingRef}
            tabIndex={-1}
          >
            {capsule.headline}
          </h2>
        </div>
        <Badge tone="accent">
          {t("chat.continuityCapsule.prepared")}
        </Badge>
      </header>

      <p className="continuity-capsule-caveat">
        {capsule.timingCaveat}{" "}
        {t("chat.continuityCapsule.citationCaveat")}
      </p>

      <div className="continuity-capsule-grid">
        <section className="continuity-capsule-section">
          <h3>{capsule.stoppedPoint.heading}</h3>
          <SourceSnapshot
            source={capsule.stoppedPoint.source}
            fallbackTitle={t("chat.continuityCapsule.sourceFallback")}
            fallbackSummary={t("chat.continuityCapsule.summaryFallback")}
            availableLabel={t(
              "chat.continuityCapsule.sourceStatus.available"
            )}
            unavailableLabel={t(
              "chat.continuityCapsule.sourceStatus.unavailable"
            )}
          />
          <div className="row-meta">
            {capsule.stoppedPoint.observedAt}
          </div>
        </section>
        <section className="continuity-capsule-section">
          <h3>{capsule.nextStep.heading}</h3>
          <SourceSnapshot
            source={capsule.nextStep.source}
            fallbackTitle={t("chat.continuityCapsule.sourceFallback")}
            fallbackSummary={t("chat.continuityCapsule.summaryFallback")}
            availableLabel={t(
              "chat.continuityCapsule.sourceStatus.available"
            )}
            unavailableLabel={t(
              "chat.continuityCapsule.sourceStatus.unavailable"
            )}
          />
        </section>
      </div>

      <section className="continuity-capsule-section">
        <h3>{t("chat.continuityCapsule.changes")}</h3>
        <p>{capsule.changes.summary}</p>
        {capsule.changes.items.length === 0 ? (
          <p className="row-meta">
            {t("chat.continuityCapsule.noChanges")}
          </p>
        ) : (
          <ul className="continuity-capsule-change-list">
            {capsule.changes.items.map((change, index) => (
              <li
                key={`${change.relationLabel}:${change.kindLabel}:${index.toString()}`}
              >
                <strong>{change.relationLabel}</strong>
                <span>{change.kindLabel}</span>
                <span className="row-meta">{change.bindingLabel}</span>
              </li>
            ))}
          </ul>
        )}
        {capsule.changes.abstentions.length > 0 ? (
          <>
            <h4>{t("chat.continuityCapsule.abstentions")}</h4>
            <ul className="continuity-capsule-change-list">
              {capsule.changes.abstentions.map((row, index) => (
                <li key={`${row.label}:${index.toString()}`}>
                  {row.label} · {row.affectedCount.toString()}{" "}
                  {row.affectedCountUnit}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="continuity-capsule-section continuity-capsule-draft">
        <div className="continuity-capsule-header">
          <div>
            <div className="continuity-capsule-kicker">
              {capsule.preparedWork.heading}
            </div>
            <h3>{capsule.preparedWork.title}</h3>
          </div>
          <Badge tone="neutral">
            {t("chat.continuityCapsule.estimate", {
              n: capsule.preparedWork.expectedMinutes
            })}
          </Badge>
        </div>
        <p>{capsule.preparedWork.content}</p>
        <p className="continuity-capsule-caveat">
          {t("chat.continuityCapsule.proposalCaveat")}{" "}
          {capsule.preparedWork.actionBoundary}
        </p>
      </section>

      <details className="continuity-capsule-disclosure">
        <summary>{capsule.disclosure.heading}</summary>
        <p>{capsule.disclosure.whyShown}</p>
        <p>{capsule.disclosure.privacyNotice}</p>
        <dl>
          <div>
            <dt>{t("chat.continuityCapsule.sourceObservation.previous")}</dt>
            <dd>{capsule.disclosure.previousObservedAt}</dd>
          </div>
          <div>
            <dt>{t("chat.continuityCapsule.sourceObservation.current")}</dt>
            <dd>{capsule.disclosure.currentObservedAt}</dd>
          </div>
        </dl>
        <dl className="continuity-capsule-integrity-list">
          <div>
            <dt>{t("chat.continuityCapsule.integrity.citationBinding")}</dt>
            <dd>{t(integrityStateKey(capsule.disclosure.verification))}</dd>
          </div>
          <div>
            <dt>{t("chat.continuityCapsule.integrity.semanticEntailment")}</dt>
            <dd>{t(integrityStateKey(capsule.preparedWork.entailment))}</dd>
          </div>
          <div>
            <dt>{t("chat.continuityCapsule.integrity.authenticatedWitness")}</dt>
            <dd>{t(integrityStateKey(capsule.disclosure.authenticatedWitness))}</dd>
          </div>
          <div>
            <dt>{t("chat.continuityCapsule.integrity.sourceFreshness")}</dt>
            <dd>{t(integrityStateKey(capsule.disclosure.sourceFreshness))}</dd>
          </div>
          <div>
            <dt>{t("chat.continuityCapsule.integrity.currentWorldTruth")}</dt>
            <dd>{t(integrityStateKey(capsule.disclosure.currentWorldTruth))}</dd>
          </div>
          <div>
            <dt>{t("chat.continuityCapsule.integrity.sourceCompleteness")}</dt>
            <dd>{t(integrityStateKey(capsule.disclosure.sourceCompleteness))}</dd>
          </div>
          <div>
            <dt>{t("chat.continuityCapsule.integrity.actionAuthority")}</dt>
            <dd>{t(integrityStateKey(capsule.disclosure.actionAuthority))}</dd>
          </div>
          <div>
            <dt>{t("chat.continuityCapsule.integrity.preparedAt")}</dt>
            <dd>{capsule.disclosure.preparedAt}</dd>
          </div>
          <div>
            <dt>{t("chat.continuityCapsule.integrity.generatedAt")}</dt>
            <dd>{capsule.disclosure.generatedAt}</dd>
          </div>
          <div>
            <dt>{t("chat.continuityCapsule.integrity.graphSources")}</dt>
            <dd>
              {t("chat.continuityCapsule.integrity.graphSourceCount", {
                displayed: capsule.disclosure.graphSources.displayed,
                omitted: capsule.disclosure.graphSources.omitted,
                total: capsule.disclosure.graphSources.total
              })}
            </dd>
          </div>
        </dl>
        <ul className="continuity-capsule-source-list">
          {capsule.disclosure.sources.map((source, index) => (
            <li
              key={`${source.observation}:${source.title ?? "untitled"}:${index.toString()}`}
            >
              {sourceTitle(
                source,
                t("chat.continuityCapsule.sourceFallback")
              )}{" "}
              ·{" "}
              {t(
                `chat.continuityCapsule.sourceObservation.${source.observation}`
              )}
            </li>
          ))}
        </ul>
        <p className="continuity-capsule-caveat">
          {t("chat.continuityCapsule.citationCaveat")}{" "}
          {t("chat.continuityCapsule.noEffect")}
        </p>
      </details>

      <div className="continuity-capsule-actions">
        <Button variant="primary" onClick={onContinue}>
          {t("chat.continuityCapsule.continue")}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          {t("chat.continuityCapsule.later")}
        </Button>
      </div>
    </article>
  );
}

function reasonKey(
  reason: ContinuityCapsuleUnavailableReason
):
  | "chat.continuityCapsule.reason.service-not-configured"
  | "chat.continuityCapsule.reason.invalid-request"
  | "chat.continuityCapsule.reason.thread-not-found"
  | "chat.continuityCapsule.reason.unsupported-source-class"
  | "chat.continuityCapsule.reason.source-unavailable"
  | "chat.continuityCapsule.reason.busy"
  | "chat.continuityCapsule.reason.capacity"
  | "chat.continuityCapsule.reason.model-not-configured"
  | "chat.continuityCapsule.reason.comparison-unavailable"
  | "chat.continuityCapsule.reason.provider-unavailable"
  | "chat.continuityCapsule.reason.provider-timeout"
  | "chat.continuityCapsule.reason.preparation-unavailable"
  | "chat.continuityCapsule.reason.presentation-unavailable" {
  return `chat.continuityCapsule.reason.${reason}`;
}

export function ContinuityCapsuleFlow({
  client,
  nudge,
  onContinue,
  onDismiss
}: {
  readonly client: ApiClient;
  readonly nudge: ContinuityNudge;
  readonly onContinue: () => void;
  readonly onDismiss: () => void;
}) {
  const { lang, t } = useI18n();
  const [settled, setSettled] = useState<Readonly<{
    readonly locale: "en" | "ko";
    readonly response: ContinuityCapsulePrepareResponse;
  }>>();
  const langRef = useRef(lang);
  const inFlightRef = useRef(false);
  useEffect(() => {
    langRef.current = lang;
    setSettled(undefined);
  }, [lang]);
  const prepare = useMutation({
    mutationFn: async (locale: "en" | "ko") => ({
      locale,
      response: await client.post<ContinuityCapsulePrepareResponse>(
        `/api/attunement/threads/${encodeURIComponent(nudge.threadId)}/capsule/prepare`,
        { locale }
      )
    }),
    onSettled: () => {
      inFlightRef.current = false;
    },
    onSuccess: (result) => {
      if (langRef.current === result.locale) {
        setSettled(result);
      }
    },
    retry: false
  });
  const requestPreparation = (): void => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSettled(undefined);
    prepare.mutate(lang);
  };
  const visible = settled?.locale === lang
    ? settled.response
    : undefined;

  if (visible?.status === "ready") {
    return (
      <ReadyCapsule
        response={visible}
        onContinue={onContinue}
        onDismiss={onDismiss}
      />
    );
  }

  return (
    <section
      className="chat-continuity-flow"
      aria-label={t("chat.continuityNudge.line", {
        title: nudge.title
      })}
      aria-busy={prepare.isPending}
    >
      <div>
        <div className="row-title">
          {t("chat.continuityNudge.line", { title: nudge.title })}
        </div>
        {prepare.isPending ? (
          <div className="row-meta" role="status" aria-live="polite">
            {t("chat.continuityCapsule.preparing")}
          </div>
        ) : null}
        {visible?.status === "seeded" ? (
          <div role="status" aria-live="polite">
            <div className="row-title">
              {t(
                visible.baselineDurability === "durable-local"
                  ? "chat.continuityCapsule.seededDurableTitle"
                  : "chat.continuityCapsule.seededProcessLocalTitle"
              )}
            </div>
            <div className="row-meta">
              {t(
                visible.baselineDurability === "durable-local"
                  ? "chat.continuityCapsule.seededDurableBody"
                  : "chat.continuityCapsule.seededProcessLocalBody"
              )}
            </div>
          </div>
        ) : null}
        {visible?.status === "unavailable" ? (
          <div role="status" aria-live="polite">
            <div className="row-title">
              {t("chat.continuityCapsule.unavailableTitle")}
            </div>
            <div className="row-meta">
              {t(reasonKey(visible.reason))}{" "}
              {t("chat.continuityCapsule.noEffect")}
            </div>
          </div>
        ) : null}
        {prepare.isError ? (
          <div className="row-meta" role="alert">
            {t("chat.continuityCapsule.reason.preparation-unavailable")}{" "}
            {t("chat.continuityCapsule.noEffect")}
          </div>
        ) : null}
      </div>
      <div className="continuity-capsule-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={prepare.isPending}
          onClick={requestPreparation}
        >
          {visible === undefined && !prepare.isError
            ? t("chat.continuityCapsule.prepare")
            : t("chat.continuityCapsule.tryAgain")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={prepare.isPending}
          onClick={onContinue}
        >
          {t("chat.continuityNudge.continue")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={prepare.isPending}
          onClick={onDismiss}
        >
          {t("chat.continuityNudge.later")}
        </Button>
      </div>
    </section>
  );
}
