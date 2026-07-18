import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { errorMessage } from "@muse/shared/browser";

import { AsyncBlock, Badge, Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { formatMetaValue } from "./flow-nodes.js";
import { writeBuilderFocusHint } from "./scheduled-logic.js";
import { linkableFlows, linkableTasks } from "./work-logic.js";

import type { ApiClient } from "../api/client.js";
import type { BoardResponse, FlowsResponse, WorkOutcomeRow, WorkRow, WorksResponse } from "../api/types.js";
import type { StringKey, Translate } from "../i18n/index.js";

export function WorkView({ client, onNavigate }: { client: ApiClient; onNavigate?: (view: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.workspace")}</p>
      <h1 className="page-title">{t("nav.work")}</h1>
      <p className="muted" style={{ marginTop: 4, marginBottom: 16 }}>{t("work.subtitle")}</p>
      <WorkTab client={client} onNavigate={onNavigate} />
    </div>
  );
}

export function WorkTab({ client, onNavigate }: { client: ApiClient; onNavigate?: (view: string) => void }) {
  const q = useQuery({
    queryFn: () => client.get<WorksResponse>("/api/works"),
    queryKey: ["works", client.baseUrl]
  });
  const works = q.data?.works ?? [];
  return (
    <AsyncBlock loading={q.isLoading} error={q.error} empty={false}>
      <WorkBody client={client} works={works} onNavigate={onNavigate} />
    </AsyncBlock>
  );
}

function statusTone(status: WorkRow["status"]): "neutral" | "ok" | "warn" {
  if (status === "done") return "ok";
  if (status === "paused") return "warn";
  return "neutral";
}

function WorkBody({ client, works, onNavigate }: { client: ApiClient; works: readonly WorkRow[]; onNavigate?: (view: string) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | undefined>(works[0]?.id);
  const [creating, setCreating] = useState(false);
  const selected = works.find((w) => w.id === selectedId) ?? works[0];

  useEffect(() => {
    if (works.length > 0 && !works.some((w) => w.id === selectedId)) {
      setSelectedId(works[0]?.id);
    }
  }, [works, selectedId]);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["works"] });

  if (creating || works.length === 0) {
    return (
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: works.length > 0 ? "280px 1fr" : "1fr" }}>
        {works.length > 0 && (
          <WorkListCard
            works={works}
            selectedId={selected?.id}
            onSelect={(id) => {
              setSelectedId(id);
              setCreating(false);
            }}
            onCreate={() => setCreating(true)}
            t={t}
          />
        )}
        {works.length === 0 && !creating ? (
          <div className="empty-block" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "40px 0" }}>
            <Icon.task className="nav-icon" />
            <div style={{ fontWeight: 600 }}>{t("work.emptyTitle")}</div>
            <div className="muted" style={{ fontSize: 13, maxWidth: 460, textAlign: "center" }}>{t("work.emptyHint")}</div>
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Icon.plus className="nav-icon" /> {t("work.create.button")}
            </Button>
          </div>
        ) : (
          <WorkCreatePanel
            client={client}
            onCancel={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              setSelectedId(id);
              invalidate();
            }}
          />
        )}
      </div>
    );
  }

  if (!selected) {
    return null;
  }

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "280px 1fr" }}>
      <WorkListCard works={works} selectedId={selected.id} onSelect={setSelectedId} onCreate={() => setCreating(true)} t={t} />
      <WorkDetail client={client} work={selected} onDeleted={() => setSelectedId(undefined)} onNavigate={onNavigate} />
    </div>
  );
}

function WorkListCard({
  works,
  selectedId,
  onSelect,
  onCreate,
  t
}: {
  works: readonly WorkRow[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onCreate: () => void;
  t: Translate;
}) {
  return (
    <Card
      title={t("work.listTitle")}
      count={works.length}
      action={
        <Button variant="ghost" size="sm" onClick={onCreate}>
          <Icon.plus className="nav-icon" /> {t("work.create.button")}
        </Button>
      }
    >
      <div className="flow-list">
        {works.map((work) => (
          <button
            type="button"
            key={work.id}
            className={`flow-list-item${work.id === selectedId ? " active" : ""}`}
            onClick={() => onSelect(work.id)}
          >
            <span className="flow-list-item-main">
              <span className="flow-list-item-title">{work.name}</span>
              <span className="flow-list-item-meta">
                <Badge tone={statusTone(work.status)}>{t(`work.status.${work.status}` as StringKey)}</Badge>
                <span style={{ marginLeft: 6 }}>{work.goal}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function WorkCreatePanel({
  client,
  onCancel,
  onCreated
}: {
  client: ApiClient;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const create = useMutation({
    mutationFn: () => client.post<{ id: string }>("/api/works", { goal: goal.trim(), name: name.trim() }),
    onSuccess: (created) => onCreated(created.id)
  });
  const canSubmit = name.trim().length > 0 && goal.trim().length > 0 && !create.isPending;
  return (
    <Card title={t("work.create.title")}>
      <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
        <input className="input" placeholder={t("work.create.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder={t("work.create.goalPlaceholder")} value={goal} onChange={(e) => setGoal(e.target.value)} />
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => create.mutate()}>
            {t("work.create.submit")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
        {create.error && <div className="banner err">{errorMessage(create.error, t("work.create.failed"))}</div>}
      </div>
    </Card>
  );
}

/** Builder-grammar link picker: choose an existing entity by NAME — never
 * type a raw id. Renders nothing when no unlinked candidate exists. */
function EntityLinkPicker({
  label,
  options,
  disabled,
  onPick
}: {
  label: string;
  options: readonly { id: string; label: string }[];
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  if (options.length === 0) {
    return null;
  }
  return (
    <select
      className="input"
      style={{ marginTop: 8 }}
      aria-label={label}
      disabled={disabled}
      value=""
      onChange={(event) => {
        if (event.target.value) {
          onPick(event.target.value);
        }
      }}
    >
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function LinkPicker({
  placeholder,
  buttonLabel,
  onLink,
  disabled
}: {
  placeholder: string;
  buttonLabel: string;
  onLink: (value: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
      <input
        className="input"
        style={{ flex: 1 }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || value.trim().length === 0}
        onClick={() => {
          onLink(value.trim());
          setValue("");
        }}
      >
        {buttonLabel}
      </Button>
    </div>
  );
}

function OutcomeTimeline({ outcomes, t }: { outcomes: readonly WorkOutcomeRow[]; t: Translate }) {
  if (outcomes.length === 0) {
    return <p className="subtle">{t("work.outcomes.empty")}</p>;
  }
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {[...outcomes].reverse().map((outcome, index) => (
        <li key={`${outcome.atIso}-${index.toString()}`}>
          [{outcome.atIso}] {t(`work.outcome.${outcome.kind}` as StringKey)}
          {outcome.note ? ` — ${outcome.note}` : ""}
        </li>
      ))}
    </ul>
  );
}

function WorkDetail({ client, work, onDeleted, onNavigate }: { client: ApiClient; work: WorkRow; onDeleted: () => void; onNavigate?: (view: string) => void }) {
  const { locale, t } = useI18n();
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["works"] });

  const flowsQuery = useQuery({
    queryFn: () => client.get<FlowsResponse>("/api/flows"),
    queryKey: ["flows", client.baseUrl]
  });
  const boardQuery = useQuery({
    queryFn: () => client.get<BoardResponse>("/api/board"),
    queryKey: ["board", client.baseUrl]
  });
  const linkedFlows = (flowsQuery.data?.flows ?? []).filter((flow) => work.flowIds.includes(flow.id));
  const linkedTasks = (boardQuery.data?.tasks ?? []).filter((task) => work.boardTaskIds.includes(task.id));

  const link = useMutation({
    mutationFn: (input: { kind: "flow" | "task" | "thread"; id: string }) =>
      client.post(`/api/works/${work.id}/link`, { id: input.id, kind: input.kind }),
    onSuccess: invalidate
  });
  const unlink = useMutation({
    mutationFn: (input: { kind: "flow" | "task"; id: string }) =>
      client.del(`/api/works/${work.id}/link`, { id: input.id, kind: input.kind }),
    onSuccess: invalidate
  });
  const outcome = useMutation({
    mutationFn: (input: { kind: "used" | "adjusted" | "ignored"; note?: string }) =>
      client.post(`/api/works/${work.id}/outcome`, { kind: input.kind, ...(input.note ? { note: input.note } : {}) }),
    onSuccess: invalidate
  });
  const markDone = useMutation({
    mutationFn: () => client.patch(`/api/works/${work.id}`, { status: "done" }),
    onSuccess: invalidate
  });
  const remove = useMutation({
    mutationFn: () => client.del(`/api/works/${work.id}`),
    onSuccess: () => {
      invalidate();
      onDeleted();
    }
  });

  const [outcomeNote, setOutcomeNote] = useState("");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}>
        <h2 className="page-title" style={{ fontSize: 20, margin: 0 }}>{work.name}</h2>
        <Badge tone={statusTone(work.status)}>{t(`work.status.${work.status}` as StringKey)}</Badge>
        {work.status !== "done" && (
          <Button variant="secondary" size="sm" disabled={markDone.isPending} onClick={() => markDone.mutate()}>
            {t("work.markDone")}
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
          <Icon.trash className="nav-icon" /> {t("work.delete")}
        </Button>
      </div>
      <p className="muted" style={{ margin: 0 }}>{work.goal}</p>

      <Card title={t("work.section.flows")} count={linkedFlows.length}>
        {linkedFlows.length === 0 ? (
          <p className="subtle">{t("work.section.flows.empty")}</p>
        ) : (
          <div className="work-links">
            {linkedFlows.map((flow) => (
              <div key={flow.id} className="work-link-row">
                <span className={`dot${flow.enabled ? " on" : ""}`} />
                <button
                  type="button"
                  className="sched-name"
                  title={t("scheduled.openInBuilder")}
                  onClick={() => {
                    writeBuilderFocusHint(typeof window === "undefined" ? undefined : window.sessionStorage, flow.id);
                    onNavigate?.("flows");
                  }}
                >
                  {flow.name}
                </button>
                <span className="sched-sub">
                  {!flow.enabled
                    ? t("auto.flows.paused")
                    : flow.nextRunAtIso
                      ? formatMetaValue("nextRunAtIso", flow.nextRunAtIso, locale)
                      : ""}
                </span>
                <Button variant="ghost" size="sm" disabled={unlink.isPending} onClick={() => unlink.mutate({ id: flow.id, kind: "flow" })}>
                  {t("work.unlink")}
                </Button>
              </div>
            ))}
          </div>
        )}
        <EntityLinkPicker
          label={t("work.linkFlowPick")}
          options={linkableFlows(flowsQuery.data?.flows ?? [], work)}
          disabled={link.isPending}
          onPick={(id) => link.mutate({ id, kind: "flow" })}
        />
      </Card>

      <Card title={t("work.section.tasks")} count={linkedTasks.length}>
        {linkedTasks.length === 0 ? (
          <p className="subtle">{t("work.section.tasks.empty")}</p>
        ) : (
          <div className="work-links">
            {linkedTasks.map((task) => (
              <div key={task.id} className="work-link-row">
                <span className="dot on" />
                <span style={{ flex: 1, minWidth: 0 }}>{task.title}</span>
                <Button variant="ghost" size="sm" disabled={unlink.isPending} onClick={() => unlink.mutate({ id: task.id, kind: "task" })}>
                  {t("work.unlink")}
                </Button>
              </div>
            ))}
          </div>
        )}
        <EntityLinkPicker
          label={t("work.linkTaskPick")}
          options={linkableTasks(boardQuery.data?.tasks ?? [], work)}
          disabled={link.isPending}
          onPick={(id) => link.mutate({ id, kind: "task" })}
        />
      </Card>

      <Card title={t("work.section.thread")}>
        <p className="subtle">
          {work.threadId ? t("work.section.thread.linked", { id: work.threadId }) : t("work.section.thread.empty")}
        </p>
        <LinkPicker
          placeholder={t("work.linkThreadPlaceholder")}
          buttonLabel={t("work.link")}
          disabled={link.isPending}
          onLink={(id) => link.mutate({ id, kind: "thread" })}
        />
      </Card>

      {link.error && <div className="banner err">{errorMessage(link.error, t("work.linkFailed"))}</div>}

      <Card title={t("work.outcomes")} count={work.outcomes.length}>
        <OutcomeTimeline outcomes={work.outcomes} t={t} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          <input
            className="input"
            style={{ maxWidth: 240 }}
            placeholder={t("work.outcomeNotePlaceholder")}
            value={outcomeNote}
            onChange={(e) => setOutcomeNote(e.target.value)}
          />
          {(["used", "adjusted", "ignored"] as const).map((kind) => (
            <Button
              key={kind}
              variant="secondary"
              size="sm"
              disabled={outcome.isPending}
              onClick={() => {
                outcome.mutate({ kind, ...(outcomeNote.trim() ? { note: outcomeNote.trim() } : {}) });
                setOutcomeNote("");
              }}
            >
              {t(`work.outcome.${kind}` as StringKey)}
            </Button>
          ))}
        </div>
        {outcome.error && <div className="banner err">{errorMessage(outcome.error, t("work.outcomeFailed"))}</div>}
      </Card>
    </div>
  );
}
