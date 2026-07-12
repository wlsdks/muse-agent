import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { BoardResponse, BoardTaskRow } from "../api/types.js";
import type { StringKey } from "../i18n/strings.js";

const COLUMNS = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" }
] as const;

interface BoardActions {
  readonly move: (id: string, status: string) => void;
  readonly retry: (id: string) => void;
  readonly review: (id: string, approved: boolean) => void;
  readonly remove: (id: string) => void;
  readonly busy: boolean;
}

type Translate = (key: StringKey) => string;

/** The verbs that make sense FOR this card's column — mirrors what
 * `muse board move/retry/review/rm` allows, so web and CLI stay one
 * mental model. Review resolution is the draft-first approval seam. */
function CardActions({ task, actions, t }: { task: BoardTaskRow; actions: BoardActions; t: Translate }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
      {task.status === "todo" && (
        <Button variant="ghost" size="sm" disabled={actions.busy} onClick={() => actions.move(task.id, "in_progress")}>
          {t("board.start")}
        </Button>
      )}
      {task.status === "in_progress" && (
        <Button variant="ghost" size="sm" disabled={actions.busy} onClick={() => actions.move(task.id, "done")}>
          {t("board.done")}
        </Button>
      )}
      {(task.status === "blocked" || task.status === "failed") && (
        <Button variant="ghost" size="sm" disabled={actions.busy} onClick={() => actions.retry(task.id)}>
          {t("board.retry")}
        </Button>
      )}
      {task.status === "review" && (
        <>
          <Button variant="primary" size="sm" disabled={actions.busy} onClick={() => actions.review(task.id, true)}>
            {t("board.approve")}
          </Button>
          <Button variant="ghost" size="sm" disabled={actions.busy} onClick={() => actions.review(task.id, false)}>
            {t("board.rejectReview")}
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={actions.busy}
        title={t("board.delete")}
        ariaLabel={t("board.delete")}
        onClick={() => actions.remove(task.id)}
      >
        <Icon.trash className="nav-icon" />
      </Button>
    </div>
  );
}

function BoardCard({ task, actions, t }: { task: BoardTaskRow; actions: BoardActions; t: Translate }) {
  return (
    <div style={{ border: "1px solid var(--hairline)", borderRadius: 8, fontSize: 13, padding: "8px 10px" }}>
      <div style={{ fontWeight: 500, overflowWrap: "anywhere" }}>{task.title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", fontSize: 11, gap: 6, marginTop: 4, opacity: 0.7 }}>
        {task.decomposed === true && <span>container{task.synthesize === true ? " · synthesis" : ""}</span>}
        {task.dependsOn.length > 0 && <span>⟵ {task.dependsOn.length.toString()} dep</span>}
      </div>
      {task.blockedReason !== undefined && task.blockedReason.length > 0 && (
        <div style={{ color: "var(--warn)", fontSize: 11, marginTop: 4, overflowWrap: "anywhere" }}>{task.blockedReason}</div>
      )}
      <CardActions task={task} actions={actions} t={t} />
    </div>
  );
}

export function BoardView({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");

  const board = useQuery({
    queryFn: () => client.get<BoardResponse>("/api/board"),
    queryKey: ["board", client.baseUrl],
    refetchInterval: 10_000
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["board", client.baseUrl] });

  const add = useMutation({
    mutationFn: () => client.post("/api/board/tasks", { title: title.trim() }),
    onSuccess: () => {
      setTitle("");
      invalidate();
    }
  });
  const move = useMutation({
    mutationFn: (input: { id: string; status: string }) => client.patch(`/api/board/tasks/${input.id}`, { status: input.status }),
    onSuccess: invalidate
  });
  const retry = useMutation({
    mutationFn: (id: string) => client.post(`/api/board/tasks/${id}/retry`),
    onSuccess: invalidate
  });
  const review = useMutation({
    mutationFn: (input: { id: string; approved: boolean }) =>
      client.post(`/api/board/tasks/${input.id}/review`, { approved: input.approved }),
    onSuccess: invalidate
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.del(`/api/board/tasks/${id}`),
    onSuccess: invalidate
  });

  const busy = add.isPending || move.isPending || retry.isPending || review.isPending || remove.isPending;
  const actions: BoardActions = {
    busy,
    move: (id, status) => move.mutate({ id, status }),
    remove: (id) => remove.mutate(id),
    retry: (id) => retry.mutate(id),
    review: (id, approved) => review.mutate({ id, approved })
  };

  const tasks = board.data?.tasks ?? [];
  return (
    <div className="content">
      <p className="eyebrow">{t("group.workspace")}</p>
      <h1 className="page-title">{t("nav.board")}</h1>

      <div style={{ display: "flex", gap: 8, margin: "16px 0", maxWidth: 560 }}>
        <input
          className="input"
          value={title}
          placeholder={t("board.addPlaceholder")}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && title.trim().length > 0) add.mutate();
          }}
        />
        <Button variant="primary" disabled={title.trim().length === 0 || add.isPending} onClick={() => add.mutate()}>
          <Icon.plus className="nav-icon" /> {t("board.add")}
        </Button>
      </div>

      {tasks.length === 0 && <p className="muted">{t("board.empty")}</p>}
      <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8 }}>
        {COLUMNS.map((col) => {
          const inCol = tasks.filter((tk) => tk.status === col.id);
          return (
            <div key={col.id} style={{ flex: "0 0 240px", minWidth: 0 }}>
              <Card title={col.label} count={inCol.length}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {inCol.map((tk) => <BoardCard key={tk.id} task={tk} actions={actions} t={t} />)}
                  {inCol.length === 0 && <span className="muted" style={{ fontSize: 12 }}>—</span>}
                </div>
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}
