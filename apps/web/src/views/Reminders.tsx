import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { ReminderRow, RemindersResponse } from "../api/types.js";

export function RemindersView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [dueAt, setDueAt] = useState("");

  const reminders = useQuery({
    queryFn: () => client.get<RemindersResponse>("/api/reminders?status=pending"),
    queryKey: ["reminders", client.baseUrl]
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["reminders"] });

  const add = useMutation({
    mutationFn: (body: { text: string; dueAt: string }) => client.post<ReminderRow>("/api/reminders", body),
    onSuccess: () => {
      setText("");
      setDueAt("");
      invalidate();
    }
  });
  const snooze = useMutation({
    mutationFn: (id: string) => client.post(`/api/reminders/${id}/snooze`, { minutes: 30 }),
    onSuccess: invalidate
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.del(`/api/reminders/${id}`),
    onSuccess: invalidate
  });

  const list = reminders.data?.reminders ?? [];
  const canAdd = text.trim().length > 0 && dueAt.length > 0;

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.workspace")}</p>
      <h1 className="page-title">{t("reminders.title")}</h1>

      <Card title={t("reminders.new")} className="lifted">
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 220px auto", alignItems: "end" }}>
          <div>
            <label className="field-label" htmlFor="rem-what">{t("reminders.what")}</label>
            <input id="rem-what" className="input" placeholder={t("reminders.whatPlaceholder")} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="rem-when">{t("reminders.when")}</label>
            <input
              id="rem-when"
              className="input"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            disabled={!canAdd || add.isPending}
            onClick={() => add.mutate({ dueAt: new Date(dueAt).toISOString(), text: text.trim() })}
          >
            <Icon.plus className="nav-icon" /> {t("common.add")}
          </Button>
        </div>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card title={t("reminders.pending")} count={reminders.data?.total ?? 0}>
          <AsyncBlock loading={reminders.isLoading} error={reminders.error} empty={list.length === 0}>
            {list.map((r) => (
              <div className="row" key={r.id}>
                <Icon.bell className="nav-icon" />
                <div className="row-main">
                  <div className="row-title">{r.text}</div>
                  <div className="row-meta">{new Date(r.dueAt).toLocaleString(locale)}</div>
                </div>
                <div className="row-actions">
                  <Button variant="ghost" size="sm" onClick={() => snooze.mutate(r.id)}>
                    {t("common.snooze30")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(r.id)} title={t("common.delete")} ariaLabel={t("common.delete")}>
                    <Icon.trash className="nav-icon" />
                  </Button>
                </div>
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>
    </div>
  );
}
