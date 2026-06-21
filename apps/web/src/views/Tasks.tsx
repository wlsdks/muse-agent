import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { TaskRow, TasksResponse } from "../api/types.js";

export function formatTaskDate(iso: string, locale: string): string {
  const d = new Date(iso);
  // A malformed/missing date renders as the literal "Invalid Date" otherwise —
  // fall back to empty, consistent with timeUntil's NaN guard (Today.tsx).
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toLocaleDateString(locale);
}

export function filterTasksByQuery(tasks: readonly TaskRow[], query: string): readonly TaskRow[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return tasks;
  }
  return tasks.filter((t) => t.title.toLowerCase().includes(q) || (t.notes ?? "").toLowerCase().includes(q));
}

export function TaskCheckbox({ status, onComplete }: { status: TaskRow["status"]; onComplete: () => void }) {
  const { t } = useI18n();
  if (status === "open") {
    return (
      <button
        className="checkbox"
        title={t("tasks.complete")}
        aria-label={t("tasks.complete")}
        onClick={onComplete}
      />
    );
  }
  return (
    <button className="checkbox" title={t("filter.done")} aria-label={t("filter.done")} disabled>
      <Icon.check className="nav-icon" />
    </button>
  );
}

export function TasksView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"open" | "done" | "all">("open");
  const [title, setTitle] = useState("");
  const [search, setSearch] = useState("");

  const key = ["tasks", client.baseUrl, filter];
  const tasks = useQuery({
    queryFn: () => client.get<TasksResponse>(`/api/tasks?status=${filter}`),
    queryKey: key
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["tasks"] });
    void qc.invalidateQueries({ queryKey: ["tasks-count"] });
  };

  const add = useMutation({
    mutationFn: (t: string) => client.post<TaskRow>("/api/tasks", { title: t }),
    onSuccess: () => {
      setTitle("");
      invalidate();
    }
  });
  const complete = useMutation({
    mutationFn: (id: string) => client.post(`/api/tasks/${id}/complete`, {}),
    onSuccess: invalidate
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.del(`/api/tasks/${id}`),
    onSuccess: invalidate
  });

  const list = filterTasksByQuery(tasks.data?.tasks ?? [], search);

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.workspace")}</p>
      <h1 className="page-title">{t("tasks.title")}</h1>

      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <input
          className="input"
          placeholder={t("tasks.placeholder")}
          aria-label={t("tasks.placeholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && title.trim()) {
              add.mutate(title.trim());
            }
          }}
        />
        <Button variant="primary" disabled={!title.trim() || add.isPending} onClick={() => add.mutate(title.trim())}>
          <Icon.plus className="nav-icon" /> {t("common.add")}
        </Button>
      </div>

      <Card
        title={t("tasks.yourTasks")}
        count={list.length}
        action={
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              className="input"
              type="search"
              aria-label={t("tasks.search")}
              placeholder={t("tasks.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 140 }}
            />
            {(["open", "done", "all"] as const).map((f) => (
              <Button key={f} variant={filter === f ? "secondary" : "ghost"} size="sm" onClick={() => setFilter(f)}>
                {t(`filter.${f}`)}
              </Button>
            ))}
          </div>
        }
      >
        <AsyncBlock loading={tasks.isLoading} error={tasks.error} empty={list.length === 0}>
          {list.map((task) => (
            <div className="row" key={task.id}>
              <TaskCheckbox status={task.status} onComplete={() => complete.mutate(task.id)} />
              <div className="row-main">
                <div
                  className="row-title"
                  style={task.status === "done" ? { color: "var(--ink-tertiary)", textDecoration: "line-through" } : undefined}
                >
                  {task.title}
                </div>
                <div className="row-meta">{formatTaskDate(task.createdAt, locale)}</div>
              </div>
              <div className="row-actions">
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(task.id)} title={t("common.delete")} ariaLabel={t("common.delete")}>
                  <Icon.trash className="nav-icon" />
                </Button>
              </div>
            </div>
          ))}
        </AsyncBlock>
      </Card>
    </div>
  );
}
