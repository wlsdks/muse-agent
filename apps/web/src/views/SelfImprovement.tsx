import { useQuery } from "@tanstack/react-query";

import { AsyncBlock, Badge, Card, Stat } from "../components/ui.js";
import { useI18n, type StringKey, type Translate } from "../i18n/index.js";
import { formatProbabilityPct } from "../lib/percent.js";
import { strategyStatusLabel, summarizeReflections, summarizeStrategies, summarizeWeaknesses, weaknessAxisLabel } from "./self-improvement.js";

import type { ApiClient } from "../api/client.js";
import type {
  PlaybookStrategiesResponse,
  ReflectionsResponse,
  SelfImprovementRuntimeState,
  SelfImprovementStatusResponse,
  SelfImprovementTickDecision,
  WeaknessesResponse
} from "../api/types.js";

const runtimeStateKeys: Record<SelfImprovementRuntimeState, StringKey> = {
  dormant: "si.runtime.dormant",
  running: "si.runtime.running",
  unconfigured: "si.runtime.unconfigured"
};

const tickDecisionKeys: Record<SelfImprovementTickDecision, StringKey> = {
  "already-running": "si.decision.alreadyRunning",
  completed: "si.decision.completed",
  disabled: "si.decision.disabled",
  error: "si.decision.error",
  "waiting-for-ac-power": "si.decision.waitingForAcPower",
  "waiting-for-foreground": "si.decision.waitingForForeground",
  "waiting-for-idle": "si.decision.waitingForIdle",
  "waiting-for-model": "si.decision.waitingForModel",
  "waiting-for-os-idle": "si.decision.waitingForOsIdle",
  "waiting-for-quiet-hours": "si.decision.waitingForQuietHours"
};

const SELF_IMPROVEMENT_STATUS_REFETCH_INTERVAL_MS = 10_000;

function decisionLabel(t: Translate, decision: SelfImprovementTickDecision | null): string {
  return decision ? t(tickDecisionKeys[decision]) : t("si.noTickObserved");
}

export function SelfImprovementView({ client }: { client: ApiClient }) {
  const { t } = useI18n();

  const weaknesses = useQuery({
    queryFn: () => client.get<WeaknessesResponse>("/api/self-improvement/weaknesses"),
    queryKey: ["self-improvement", client.baseUrl]
  });
  const strategies = useQuery({
    queryFn: () => client.get<PlaybookStrategiesResponse>("/api/self-improvement/playbook"),
    queryKey: ["self-improvement-playbook", client.baseUrl]
  });
  const reflections = useQuery({
    queryFn: () => client.get<ReflectionsResponse>("/api/self-improvement/reflections"),
    queryKey: ["self-improvement-reflections", client.baseUrl]
  });
  const status = useQuery({
    queryFn: () => client.get<SelfImprovementStatusResponse>("/api/self-improvement/status"),
    queryKey: ["self-improvement-status", client.baseUrl],
    refetchInterval: SELF_IMPROVEMENT_STATUS_REFETCH_INTERVAL_MS
  });

  const entries = weaknesses.data?.entries ?? [];
  const { total, axes } = summarizeWeaknesses(entries);
  const strategyEntries = strategies.data?.entries ?? [];
  const strategyCounts = summarizeStrategies(strategyEntries);
  const reflectionEntries = reflections.data?.entries ?? [];
  const reflectionCounts = summarizeReflections(reflectionEntries);

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("si.title")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("si.subtitle", { n: total, a: axes })}
      </p>

      <h2 className="page-title" style={{ marginTop: 32, fontSize: 20 }}>
        {t("si.statusTitle")}
      </h2>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("si.statusSubtitle")}
      </p>
      <div style={{ marginTop: 16 }}>
        <AsyncBlock loading={status.isLoading} error={status.error}>
          {status.data ? (
            <Card>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Badge tone={status.data.enabled ? "ok" : "neutral"}>
                  {status.data.enabled ? t("si.enabled") : t("si.disabled")}
                </Badge>
                <Badge tone={status.data.paused ? "warn" : "ok"}>
                  {status.data.paused ? t("si.paused") : t("si.notPaused")}
                </Badge>
                <Badge tone={status.data.state === "running" ? "ok" : status.data.state === "unconfigured" ? "err" : "neutral"}>
                  {t(runtimeStateKeys[status.data.state])}
                </Badge>
              </div>
              <p style={{ margin: "10px 0 0" }}>
                {t("si.pendingCorrections", { n: status.data.pendingCorrections })}
              </p>
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                {status.data.pendingCorrections === 0 ? t("si.pendingNone") : t("si.pendingSome")}
              </p>
              <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>
                {t("si.lastDecision", { decision: decisionLabel(t, status.data.lastDecision) })}
                {status.data.lastObservedAtIso ? <span className="mono"> · {status.data.lastObservedAtIso}</span> : null}
              </p>
            </Card>
          ) : null}
        </AsyncBlock>
      </div>

      <div style={{ marginTop: 16 }}>
        <AsyncBlock loading={weaknesses.isLoading} error={weaknesses.error} empty={entries.length === 0}>
          {entries.map((entry, idx) => (
            <div key={`${entry.axis}:${entry.topic}:${idx}`} style={{ marginBottom: 10 }}>
              <Card>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Badge tone="neutral">{weaknessAxisLabel(entry.axis)}</Badge>
                      <strong>{entry.topic}</strong>
                    </div>
                    {entry.hint ? (
                      <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                        {entry.hint}
                      </p>
                    ) : null}
                    <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-muted, #888)" }}>
                      {t("si.lastSeen")}: <span className="mono">{entry.lastSeen}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                    <span className="mono subtle">{t("si.count", { n: entry.count })}</span>
                    {entry.pKnown !== null ? (
                      <Stat value={formatProbabilityPct(entry.pKnown)} label={t("si.mastery")} />
                    ) : null}
                  </div>
                </div>
              </Card>
            </div>
          ))}
        </AsyncBlock>
      </div>

      <h2 className="page-title" style={{ marginTop: 32, fontSize: 20 }}>
        {t("si.strategiesTitle")}
      </h2>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("si.strategiesSubtitle", { active: strategyCounts.active, probation: strategyCounts.probation })}
      </p>

      <div style={{ marginTop: 16 }}>
        <AsyncBlock
          loading={strategies.isLoading}
          error={strategies.error}
          empty={strategyEntries.length === 0}
        >
          {strategyEntries.map((entry) => {
            const status = strategyStatusLabel(entry);
            return (
              <div key={entry.id} style={{ marginBottom: 10 }}>
                <Card>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <Badge tone={status === "active" ? "ok" : "neutral"}>{t(`si.${status}`)}</Badge>
                        {entry.tag ? <Badge tone="neutral">{entry.tag}</Badge> : null}
                        {entry.origin ? <span className="mono subtle">{entry.origin}</span> : null}
                      </div>
                      <p style={{ margin: "6px 0 0" }}>{entry.text}</p>
                    </div>
                    <span className="mono subtle" style={{ flexShrink: 0 }}>
                      {t("si.reward", { n: entry.reward })}
                    </span>
                  </div>
                </Card>
              </div>
            );
          })}
        </AsyncBlock>
      </div>

      <h2 className="page-title" style={{ marginTop: 32, fontSize: 20 }}>
        {t("si.reflectionsTitle")}
      </h2>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("si.reflectionsSubtitle", { n: reflectionCounts.total, g: reflectionCounts.grounded })}
      </p>

      <div style={{ marginTop: 16 }}>
        <AsyncBlock
          loading={reflections.isLoading}
          error={reflections.error}
          empty={reflectionEntries.length === 0}
        >
          {reflectionEntries.map((entry) => (
            <div key={entry.id} style={{ marginBottom: 10 }}>
              <Card>
                <p style={{ margin: "0 0 8px" }}>{entry.insight}</p>
                <div style={{ display: "flex", gap: 8 }}>
                  <span className="mono subtle">{t("si.support", { n: entry.supportCount })}</span>
                  <span className="mono subtle">{t("si.sources", { n: entry.sourceCount })}</span>
                </div>
              </Card>
            </div>
          ))}
        </AsyncBlock>
      </div>
    </div>
  );
}
