import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Card, Empty } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { UserMemoryResponse } from "../api/types.js";
import type { Translate } from "../i18n/index.js";

// The label that introduces the timestamp lives in `memory.updated`, NOT
// baked onto `memory.subtitle` — otherwise the subtitle dangles a bare
// "Updated" with no value whenever the memory has no `updatedAt` yet.
export function memorySubtitle(t: Translate, locale: string, updatedAt?: string): string {
  const base = t("memory.subtitle");
  if (!updatedAt) return base;
  return `${base} · ${t("memory.updated", { when: new Date(updatedAt).toLocaleString(locale) })}`;
}

/**
 * Read-only window into what Muse remembers about the user — the facts
 * and preferences its auto-extraction has learned. Read-only on purpose
 * (transparency, not editing): there is no per-fact delete on the API,
 * and curation belongs to the agent/CLI path.
 */
export function MemoryView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const [userId, setUserId] = useState("default");

  const memory = useQuery({
    queryFn: async () => {
      try {
        return await client.get<UserMemoryResponse>(`/api/user-memory/${encodeURIComponent(userId)}`);
      } catch {
        // 404 = no memory recorded for this id yet.
        return {} as UserMemoryResponse;
      }
    },
    queryKey: ["memory", client.baseUrl, userId]
  });

  const facts = Object.entries(memory.data?.facts ?? {});
  const prefs = Object.entries(memory.data?.preferences ?? {});
  const topics = memory.data?.recentTopics ?? [];

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.knowledge")}</p>
      <h1 className="page-title">{t("nav.memory")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {memorySubtitle(t, locale, memory.data?.updatedAt)}
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "16px 0" }}>
        <label className="field-label" style={{ margin: 0 }}>
          {t("memory.userId")}
        </label>
        <input
          className="input"
          style={{ maxWidth: 240 }}
          aria-label={t("memory.userId")}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
      </div>

      <AsyncBlock loading={memory.isLoading} error={memory.error}>
        <div className="grid grid-2">
          <Card title={t("memory.facts")} count={facts.length}>
            {facts.length === 0 ? (
              <Empty>{t("common.empty")}</Empty>
            ) : (
              facts.map(([k, v]) => (
                <div className="row" key={k}>
                  <div className="row-main">
                    <div className="row-title">{v}</div>
                    <div className="row-meta mono">{k}</div>
                  </div>
                </div>
              ))
            )}
          </Card>

          <Card title={t("memory.preferences")} count={prefs.length}>
            {prefs.length === 0 ? (
              <Empty>{t("common.empty")}</Empty>
            ) : (
              prefs.map(([k, v]) => (
                <div className="row" key={k}>
                  <div className="row-main">
                    <div className="row-title">{v}</div>
                    <div className="row-meta mono">{k}</div>
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>

        {topics.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <Card title={t("memory.recentTopics")} count={topics.length}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {topics.map((topic, i) => (
                  <span className="badge" key={i}>
                    {topic}
                  </span>
                ))}
              </div>
            </Card>
          </div>
        )}
      </AsyncBlock>
    </div>
  );
}
