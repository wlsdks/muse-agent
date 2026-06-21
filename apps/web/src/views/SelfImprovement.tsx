import { useQuery } from "@tanstack/react-query";

import { AsyncBlock, Badge, Card, Stat } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { formatProbabilityPct } from "../lib/percent.js";
import { strategyStatusLabel, summarizeStrategies, summarizeWeaknesses, weaknessAxisLabel } from "./self-improvement.js";

import type { ApiClient } from "../api/client.js";
import type { PlaybookStrategiesResponse, WeaknessesResponse } from "../api/types.js";

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

  const entries = weaknesses.data?.entries ?? [];
  const { total, axes } = summarizeWeaknesses(entries);
  const strategyEntries = strategies.data?.entries ?? [];
  const strategyCounts = summarizeStrategies(strategyEntries);

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("si.title")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("si.subtitle", { n: total, a: axes })}
      </p>

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
    </div>
  );
}
