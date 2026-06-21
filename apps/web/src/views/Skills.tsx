import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AsyncBlock, Badge, Button, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { canAdjustReward, rewardDelta, summarizeSkills } from "./skill-list.js";

import type { ApiClient } from "../api/client.js";
import type { SkillsResponse } from "../api/types.js";

export function SkillsView({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const skills = useQuery({
    queryFn: () => client.get<SkillsResponse>("/api/self-improvement/skills"),
    queryKey: ["skills", client.baseUrl]
  });

  const reward = useMutation({
    mutationFn: ({ name, direction }: { name: string; direction: "up" | "down" }) =>
      client.post<{ name: string; reward: number }>(
        `/api/self-improvement/skills/${encodeURIComponent(name)}/reward`,
        { delta: rewardDelta(direction) }
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["skills"] })
  });

  const entries = skills.data?.entries ?? [];
  const counts = summarizeSkills(entries);

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("skills.title")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("skills.subtitle", { n: counts.total, a: counts.avoided })}
      </p>

      <div style={{ marginTop: 16 }}>
        <AsyncBlock loading={skills.isLoading} error={skills.error} empty={entries.length === 0}>
          {entries.map((entry, idx) => (
            <div key={`${entry.name}:${idx}`} style={{ marginBottom: 10 }}>
              <Card>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <strong>{entry.name}</strong>
                      <Badge tone="neutral">{entry.source}</Badge>
                      {entry.avoided ? <Badge tone="warn">{t("skills.avoided")}</Badge> : null}
                    </div>
                    {entry.description ? (
                      <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                        {entry.description}
                      </p>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <span className="mono subtle">
                      {t("skills.reward", { n: entry.reward })}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      title={t("skills.rewardUp")}
                      ariaLabel={t("skills.rewardUp")}
                      disabled={reward.isPending || !canAdjustReward(entry.reward, "up")}
                      onClick={() => reward.mutate({ name: entry.name, direction: "up" })}
                    >
                      ▲
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title={t("skills.rewardDown")}
                      ariaLabel={t("skills.rewardDown")}
                      disabled={reward.isPending || !canAdjustReward(entry.reward, "down")}
                      onClick={() => reward.mutate({ name: entry.name, direction: "down" })}
                    >
                      ▼
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          ))}
        </AsyncBlock>
      </div>
    </div>
  );
}
