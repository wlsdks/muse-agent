import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { ToolCatalogEntry, ToolCatalogResponse } from "../api/types.js";

function riskTone(risk: ToolCatalogEntry["risk"]): "ok" | "warn" | "err" {
  if (risk === "read") return "ok";
  if (risk === "write") return "warn";
  return "err";
}

export function ToolsView({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const tools = useQuery({
    queryFn: () => client.get<ToolCatalogResponse>("/api/tools"),
    queryKey: ["tools", client.baseUrl]
  });

  const q = query.trim().toLowerCase();
  const list = (tools.data?.tools ?? []).filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
  );

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("tools.title")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("tools.subtitle", { n: tools.data?.total ?? 0 })}
      </p>

      <input
        className="input"
        style={{ margin: "16px 0" }}
        placeholder={t("tools.filterPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <AsyncBlock loading={tools.isLoading} error={tools.error} empty={list.length === 0}>
        <div className="grid grid-2">
          {list.map((t) => (
            <Card key={t.name}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span className="mono" style={{ color: "var(--ink)", fontSize: 14 }}>
                  {t.name}
                </span>
                <span style={{ marginLeft: "auto" }}>
                  <Badge tone={riskTone(t.risk)}>{t.risk}</Badge>
                </span>
              </div>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
                {t.description}
              </div>
              {t.keywords && t.keywords.length > 0 && (
                <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {t.keywords.slice(0, 6).map((k) => (
                    <Badge key={k} dot={false}>
                      {k}
                    </Badge>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      </AsyncBlock>
    </div>
  );
}
