import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Button, Card, Icon } from "../components/ui.js";

import type { ApiClient } from "../api/client.js";
import type { TaskRow, TasksResponse } from "../api/types.js";

export function TasksView({ client }: { client: ApiClient }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"open" | "done" | "all">("open");
  const [title, setTitle] = useState("");

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

  const list = tasks.data?.tasks ?? [];

  return (
    <div className="content-narrow">
      <p className="eyebrow">Workspace</p>
      <h1 className="page-title">Tasks</h1>

      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <input
          className="input"
          placeholder="Add a task and press Enter…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && title.trim()) {
              add.mutate(title.trim());
            }
          }}
        />
        <Button variant="primary" disabled={!title.trim() || add.isPending} onClick={() => add.mutate(title.trim())}>
          <Icon.plus className="nav-icon" /> Add
        </Button>
      </div>

      <Card
        title="Your tasks"
        count={tasks.data?.total ?? 0}
        action={
          <div style={{ display: "flex", gap: 4 }}>
            {(["open", "done", "all"] as const).map((f) => (
              <Button key={f} variant={filter === f ? "secondary" : "ghost"} size="sm" onClick={() => setFilter(f)}>
                {f}
              </Button>
            ))}
          </div>
        }
      >
        <AsyncBlock loading={tasks.isLoading} error={tasks.error} empty={list.length === 0}>
          {list.map((t) => (
            <div className="row" key={t.id}>
              {t.status === "open" ? (
                <button className="checkbox" title="Complete" onClick={() => complete.mutate(t.id)} />
              ) : (
                <button className="checkbox" title="Done" disabled>
                  <Icon.check className="nav-icon" />
                </button>
              )}
              <div className="row-main">
                <div
                  className="row-title"
                  style={t.status === "done" ? { color: "var(--ink-tertiary)", textDecoration: "line-through" } : undefined}
                >
                  {t.title}
                </div>
                <div className="row-meta">{new Date(t.createdAt).toLocaleDateString()}</div>
              </div>
              <div className="row-actions">
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(t.id)} title="Delete">
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
