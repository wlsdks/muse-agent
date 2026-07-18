import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Button, Card, Empty, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { factLabel, groupFactsByValue } from "../lib/memory-labels.js";
import { seedChat } from "./home-logic.js";

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
/** The "what Muse knows" surface, rendered as the 기억 tab inside Notes —
 * the standalone Memory view folded in (both are knowledge surfaces). */
export function MemorySections({ client, onNavigate }: { client: ApiClient; onNavigate?: (view: string) => void }) {
  const { lang, locale, t } = useI18n();
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

  const factGroups = groupFactsByValue(memory.data?.facts ?? {});
  const facts = Object.entries(memory.data?.facts ?? {});
  const prefs = Object.entries(memory.data?.preferences ?? {});
  const topics = memory.data?.recentTopics ?? [];

  return (
    <div>
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
        {facts.length === 0 && prefs.length === 0 && topics.length === 0 ? (
          <Card>
            <Empty
              icon={<Icon.brain />}
              hint={t("memory.emptyHint")}
              action={
                onNavigate
                  ? { icon: <Icon.chat className="nav-icon" />, label: t("memory.startChat"), onClick: () => onNavigate("chat") }
                  : undefined
              }
            >
              {t("memory.emptyTitle")}
            </Empty>
          </Card>
        ) : (
          <>
        <div className="grid grid-2">
          <Card title={t("memory.facts")} count={factGroups.length}>
            {factGroups.length === 0 ? (
              <Empty>{t("common.empty")}</Empty>
            ) : (
              factGroups.map((group) => (
                <div className="row" key={group.value} title={group.keys.join(", ")}>
                  <div className="row-main">
                    <div className="row-title">{group.value}</div>
                    <div className="row-meta">{group.keys.map((k) => factLabel(k, lang)).join(" · ")}</div>
                  </div>
                  {onNavigate && (
                    <div className="row-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          seedChat(
                            t("home.learned.forgetPrompt", { label: factLabel(group.keys[0] ?? "", lang), value: group.value }),
                            onNavigate
                          )
                        }
                      >
                        {t("home.learned.forget")}
                      </Button>
                    </div>
                  )}
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
          </>
        )}
      </AsyncBlock>
    </div>
  );
}
