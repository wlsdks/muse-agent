import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Button, Card, Empty } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { NotesListResponse, NotesReadResponse, NotesSearchResponse } from "../api/types.js";

export function NotesView({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);

  const list = useQuery({
    queryFn: () => client.get<NotesListResponse>("/api/notes/list"),
    queryKey: ["notes-list", client.baseUrl]
  });
  const search = useQuery({
    enabled: query.trim().length > 1,
    queryFn: () => client.get<NotesSearchResponse>(`/api/notes/search?q=${encodeURIComponent(query.trim())}`),
    queryKey: ["notes-search", client.baseUrl, query.trim()]
  });
  const reading = useQuery({
    enabled: active !== null,
    queryFn: () => client.get<NotesReadResponse>(`/api/notes/read?name=${encodeURIComponent(active ?? "")}`),
    queryKey: ["notes-read", client.baseUrl, active]
  });

  const files = (list.data?.entries ?? []).filter((e) => !e.isDirectory);
  const searching = query.trim().length > 1;

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.knowledge")}</p>
      <h1 className="page-title">{t("notes.title")}</h1>

      <input
        className="input"
        style={{ margin: "16px 0" }}
        placeholder={t("notes.searchPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="grid grid-2">
        <Card title={searching ? t("notes.results") : t("notes.files")} count={searching ? search.data?.hits.length ?? 0 : files.length}>
          {searching ? (
            <AsyncBlock loading={search.isLoading} error={search.error} empty={(search.data?.hits.length ?? 0) === 0}>
              {(search.data?.hits ?? []).map((h, i) => (
                <button
                  key={`${h.file}-${i}`}
                  className="row"
                  style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid var(--hairline)", textAlign: "left", cursor: "pointer" }}
                  onClick={() => setActive(h.file)}
                >
                  <div className="row-main">
                    <div className="row-title">{h.file}</div>
                    <div className="row-meta mono">
                      :{h.line} {h.text.trim().slice(0, 80)}
                    </div>
                  </div>
                </button>
              ))}
            </AsyncBlock>
          ) : (
            <AsyncBlock loading={list.isLoading} error={list.error} empty={files.length === 0}>
              {files.map((f) => (
                <button
                  key={f.name}
                  className="row"
                  style={{ width: "100%", background: active === f.name ? "var(--surface-2)" : "none", border: "none", borderBottom: "1px solid var(--hairline)", textAlign: "left", cursor: "pointer", borderRadius: 6 }}
                  onClick={() => setActive(f.name)}
                >
                  <div className="row-main">
                    <div className="row-title">{f.name}</div>
                    {f.sizeBytes !== undefined && <div className="row-meta">{f.sizeBytes} bytes</div>}
                  </div>
                </button>
              ))}
            </AsyncBlock>
          )}
        </Card>

        <Card
          title={active ?? t("notes.reader")}
          action={active ? <Button variant="ghost" size="sm" onClick={() => setActive(null)}>{t("common.close")}</Button> : undefined}
        >
          {!active ? (
            <Empty>{t("notes.selectNote")}</Empty>
          ) : (
            <AsyncBlock loading={reading.isLoading} error={reading.error}>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: "var(--ink-muted)",
                  margin: 0,
                  maxHeight: 460,
                  overflowY: "auto"
                }}
              >
                {reading.data?.content ?? ""}
              </pre>
            </AsyncBlock>
          )}
        </Card>
      </div>
    </div>
  );
}
