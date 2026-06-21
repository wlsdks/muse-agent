import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Button, Card, Empty, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { NotesListResponse, NotesReadResponse, NotesSearchResponse } from "../api/types.js";

export function NotesView({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editBody, setEditBody] = useState("");

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
    enabled: active !== null && !editing,
    queryFn: () => client.get<NotesReadResponse>(`/api/notes/read?name=${encodeURIComponent(active ?? "")}`),
    queryKey: ["notes-read", client.baseUrl, active]
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ["notes-list"] });
  const save = useMutation({
    mutationFn: (note: { path: string; content: string }) =>
      client.post("/api/notes/save", { content: note.content, overwrite: true, path: note.path }),
    onSuccess: (_data, note) => {
      setEditing(false);
      setActive(note.path);
      refresh();
      void qc.invalidateQueries({ queryKey: ["notes-read"] });
    }
  });
  const remove = useMutation({
    mutationFn: (name: string) => client.del(`/api/notes?path=${encodeURIComponent(name)}`),
    onSuccess: (_data, name) => {
      if (active === name) {
        setActive(null);
      }
      refresh();
    }
  });

  const files = (list.data?.entries ?? []).filter((e) => !e.isDirectory);
  const searching = query.trim().length > 1;

  const startNew = () => {
    setActive(null);
    setEditName("");
    setEditBody("");
    setEditing(true);
  };
  const startEdit = () => {
    setEditName(active ?? "");
    setEditBody(reading.data?.content ?? "");
    setEditing(true);
  };

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.knowledge")}</p>
      <h1 className="page-title">{t("notes.title")}</h1>

      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <input
          className="input"
          placeholder={t("notes.searchPlaceholder")}
          aria-label={t("notes.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button variant="primary" onClick={startNew}>
          <Icon.plus className="nav-icon" /> {t("notes.new")}
        </Button>
      </div>

      <div className="grid grid-2">
        <Card title={searching ? t("notes.results") : t("notes.files")} count={searching ? search.data?.hits.length ?? 0 : files.length}>
          {searching ? (
            <AsyncBlock loading={search.isLoading} error={search.error} empty={(search.data?.hits.length ?? 0) === 0}>
              {(search.data?.hits ?? []).map((h, i) => (
                <button
                  key={`${h.file}-${i}`}
                  className="row note-row"
                  onClick={() => {
                    setEditing(false);
                    setActive(h.file);
                  }}
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
                <div className={`row note-row${active === f.name ? " active" : ""}`} key={f.name}>
                  <button
                    className="row-main note-open"
                    onClick={() => {
                      setEditing(false);
                      setActive(f.name);
                    }}
                  >
                    <div className="row-title">{f.name}</div>
                    {f.sizeBytes !== undefined && <div className="row-meta">{f.sizeBytes} bytes</div>}
                  </button>
                  <Button variant="ghost" size="sm" title={t("common.delete")} ariaLabel={t("common.delete")} onClick={() => remove.mutate(f.name)}>
                    <Icon.trash className="nav-icon" />
                  </Button>
                </div>
              ))}
            </AsyncBlock>
          )}
        </Card>

        <Card
          title={editing ? t("notes.new") : active ?? t("notes.reader")}
          action={
            editing ? (
              <Button variant="primary" size="sm" disabled={!editName.trim() || save.isPending} onClick={() => save.mutate({ content: editBody, path: editName.trim() })}>
                {t("notes.save")}
              </Button>
            ) : active ? (
              <div style={{ display: "flex", gap: 4 }}>
                <Button variant="ghost" size="sm" onClick={startEdit}>
                  {t("notes.edit")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setActive(null)}>
                  {t("common.close")}
                </Button>
              </div>
            ) : undefined
          }
        >
          {editing ? (
            <div style={{ display: "grid", gap: 10 }}>
              <input
                className="input"
                placeholder={t("notes.namePlaceholder")}
                aria-label={t("notes.namePlaceholder")}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
              <textarea
                className="textarea"
                style={{ minHeight: 360, fontFamily: "var(--font-mono)", fontSize: 13 }}
                placeholder={t("notes.bodyPlaceholder")}
                aria-label={t("notes.bodyPlaceholder")}
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
              />
            </div>
          ) : !active ? (
            <Empty>{t("notes.selectNote")}</Empty>
          ) : (
            <AsyncBlock loading={reading.isLoading} error={reading.error}>
              <pre className="note-content">{reading.data?.content ?? ""}</pre>
            </AsyncBlock>
          )}
        </Card>
      </div>
    </div>
  );
}
