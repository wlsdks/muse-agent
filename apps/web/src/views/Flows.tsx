import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applyNodeChanges, ReactFlow, ReactFlowProvider, type NodeChange } from "@xyflow/react";
import { useEffect, useState } from "react";
import { errorMessage } from "@muse/shared/browser";

import "@xyflow/react/dist/style.css";

import { AsyncBlock, Button, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { canvasWithNotifyGhost, classifyEdgeRemoval, isNotifyGhostId } from "./flow-connection-logic.js";
import { flowToCanvas } from "./flow-canvas-mapping.js";
import { readNodePositions, writeNodePosition } from "./flow-node-positions.js";
import { consumeBuilderCreateForWorkHint, consumeBuilderFocusHint } from "./scheduled-logic.js";
import { FLOW_EDGE_TYPES } from "./flow-edges.js";
import { flowDraftToCopilotPayload, flowEditToJobPatch, renameFlowPatch, toggleEnabledPatch } from "./flow-edit-compile.js";
import { FlowCreatePanel } from "./flow-create-panel.js";
import { FlowDraftComposer } from "./flow-draft-composer.js";
import { NotifyChannelQuickPick } from "./flow-notify-picker.js";
import { FlowNodeEditPanel } from "./flow-edit-panel.js";
import { dryRunUrl } from "./flow-executions-compile.js";
import { ExecutionsCard, executionsQueryKey } from "./flow-executions.js";
import { formatMetaValue, FLOW_NODE_TYPES } from "./flow-nodes.js";

import type { FlowCanvasEdge, FlowCanvasNode } from "./flow-canvas-mapping.js";
import type { FlowDraft } from "./flow-edit-compile.js";
import type { ApiClient } from "../api/client.js";
import type { FlowDraftPayloadRow, FlowProjection, FlowsResponse } from "../api/types.js";


export function FlowsView({ client }: { client: ApiClient }) {
  return (
    <div className="builder-ws">
      <FlowsTab client={client} />
    </div>
  );
}

export function FlowsTab({ client }: { client: ApiClient }) {
  const q = useQuery({
    queryFn: () => client.get<FlowsResponse>("/api/flows"),
    queryKey: ["flows", client.baseUrl]
  });
  const flows = q.data?.flows ?? [];

  return (
    <AsyncBlock loading={q.isLoading} error={q.error} empty={false}>
      <FlowsBody client={client} flows={flows} />
    </AsyncBlock>
  );
}

type SideTab = "chat" | "node" | "exec";

function FlowsBody({ client, flows }: { client: ApiClient; flows: readonly FlowProjection[] }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [selectedFlowId, setSelectedFlowId] = useState<string | undefined>(() =>
    // A one-shot handoff from Scheduled's "open in Builder" — consumed (and
    // cleared) here so a later manual visit doesn't snap back to it.
    consumeBuilderFocusHint(typeof window === "undefined" ? undefined : window.sessionStorage) ?? flows[0]?.id
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [initialDraft, setInitialDraft] = useState<FlowDraftPayloadRow | undefined>(undefined);
  const [draftVersion, setDraftVersion] = useState(0);
  const [sideTab, setSideTab] = useState<SideTab>("chat");
  const [zen, setZen] = useState(false);
  // Work → Builder handoff: arrive with the create panel open and, once the
  // flow is created, link it back to that Work automatically (one-shot).
  const [createForWorkId, setCreateForWorkId] = useState<string | undefined>(() =>
    consumeBuilderCreateForWorkHint(typeof window === "undefined" ? undefined : window.sessionStorage)
  );
  useEffect(() => {
    if (createForWorkId) {
      setCreating(true);
    }
    // mount-only: the hint is consumed exactly once by the state initializer
  }, []);

  // Full-workspace mode: the builder hides the app chrome (sidebar + topbar)
  // via a root attribute so the CSS can reach OUTSIDE this subtree. Cleaned
  // up on unmount so leaving the Builder view always restores the chrome.
  useEffect(() => {
    const root = document.documentElement;
    if (zen) {
      root.setAttribute("data-builder-zen", "true");
    } else {
      root.removeAttribute("data-builder-zen");
    }
    return () => root.removeAttribute("data-builder-zen");
  }, [zen]);
  useEffect(() => {
    if (!zen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      // The canvas's own fullscreen overlay owns Escape while it's open —
      // one Escape should peel one layer, not both.
      if (event.key === "Escape" && !document.querySelector(".flow-canvas-fullscreen")) {
        setZen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zen]);
  // The create panel's LIVE form values, mirrored up via `onDraftChange` —
  // this (not the last server-returned draft) is what a follow-up
  // conversational revision turn sends as `currentDraft`, so a manual form
  // edit between turns is respected.
  const [liveDraft, setLiveDraft] = useState<FlowDraft | undefined>(undefined);

  const selectedFlow = flows.find((flow) => flow.id === selectedFlowId) ?? flows[0];

  useEffect(() => {
    setSelectedNodeId(undefined);
  }, [selectedFlow?.id]);

  const openCreatePanel = () => {
    setInitialDraft(undefined);
    setLiveDraft(undefined);
    // A MANUAL open is never Work-bound — only the hint-opened panel is.
    setCreateForWorkId(undefined);
    setCreating(true);
  };
  const handleDrafted = (draft: FlowDraftPayloadRow) => {
    setInitialDraft(draft);
    setDraftVersion((version) => version + 1);
    setCreating(true);
  };
  const closeCreatePanel = () => {
    setCreating(false);
    setLiveDraft(undefined);
    // Cancelling ends the Work binding — a flow created LATER in this
    // session must not silently link back to that Work.
    setCreateForWorkId(undefined);
  };
  // The copilot drafts BOTH kinds (agent prompts and read-risk tool flows),
  // so a revision turn always carries the live form state.
  const currentDraft = creating && liveDraft
    ? flowDraftToCopilotPayload(liveDraft)
    : undefined;

  return (
    <>
      <header className="ws-head">
        <FlowSwitcher
          flows={flows}
          selectedId={selectedFlow?.id}
          onSelect={(id) => {
            setSelectedFlowId(id);
            closeCreatePanel();
          }}
          onCreate={openCreatePanel}
        />
        <span className="ws-spacer" />
        <button
          type="button"
          className="ws-zen-btn"
          aria-pressed={zen}
          aria-label={t(zen ? "auto.flows.zen.exit" : "auto.flows.zen.enter")}
          title={t(zen ? "auto.flows.zen.exit" : "auto.flows.zen.enter")}
          onClick={() => setZen((value) => !value)}
        >
          {zen ? <Icon.shrink /> : <Icon.expand />}
        </button>
      </header>

      <div className="ws-body">
        <div className="ws-main">
          {creating ? (
            <div className="ws-create">
              <FlowCreatePanel
                key={initialDraft ? `draft-${draftVersion.toString()}` : "empty"}
                client={client}
                initialDraft={initialDraft}
                onDraftChange={setLiveDraft}
                onCancel={closeCreatePanel}
                onCreated={(jobId) => {
                  closeCreatePanel();
                  setSelectedFlowId(jobId);
                  if (createForWorkId) {
                    const workId = createForWorkId;
                    setCreateForWorkId(undefined);
                    void client
                      .post(`/api/works/${workId}/link`, { id: jobId, kind: "flow" })
                      .then(() => void qc.invalidateQueries({ queryKey: ["works"] }))
                      .catch(() => {
                        /* linking is best-effort sugar — the flow itself was
                           created; the user can still link it from the Work view */
                      });
                  }
                }}
              />
            </div>
          ) : !selectedFlow ? (
            // Zero flows must still offer the create entry point; the copilot
            // stays available in the side panel.
            <div className="empty-block" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "40px 0" }}>
              <Icon.activity className="nav-icon" />
              <div style={{ fontWeight: 600 }}>{t("auto.flows.emptyTitle")}</div>
              <div className="muted" style={{ fontSize: 13, maxWidth: 420, textAlign: "center" }}>{t("auto.flows.emptyHint")}</div>
              <Button variant="primary" size="sm" onClick={openCreatePanel}>
                <Icon.plus className="nav-icon" /> {t("auto.flows.create.button")}
              </Button>
            </div>
          ) : (
            <>
              <FlowHeaderActions
                client={client}
                flow={selectedFlow}
                onDeleted={() => {
                  setSelectedFlowId(flows.find((flow) => flow.id !== selectedFlow.id)?.id);
                }}
                onDuplicated={(jobId) => setSelectedFlowId(jobId)}
              />
              <div className="ws-main-canvas">
                <FlowCanvasArea
                  client={client}
                  flow={selectedFlow}
                  onSelectNode={(id) => {
                    setSelectedNodeId(id);
                    setSideTab("node");
                  }}
                  onDeselectNode={() => setSelectedNodeId(undefined)}
                />
              </div>
            </>
          )}
        </div>

        <aside className="ws-side">
          <div className="ws-side-tabs" role="tablist">
            <button role="tab" aria-selected={sideTab === "chat"} className={sideTab === "chat" ? "on" : ""} onClick={() => setSideTab("chat")}>
              ✦ {t("auto.flows.side.copilot")}
            </button>
            <button role="tab" aria-selected={sideTab === "node"} className={sideTab === "node" ? "on" : ""} onClick={() => setSideTab("node")}>
              {t("auto.flows.detailTitle")}
            </button>
            <button role="tab" aria-selected={sideTab === "exec"} className={sideTab === "exec" ? "on" : ""} onClick={() => setSideTab("exec")}>
              {t("auto.flows.executions.title")}
            </button>
          </div>
          <div className="ws-side-body">
            {sideTab === "chat" && (
              <FlowDraftComposer client={client} onDrafted={handleDrafted} currentDraft={currentDraft} />
            )}
            {sideTab === "node" && (
              selectedFlow && selectedNodeId ? (
                <FlowNodeDetailHost
                  client={client}
                  flow={selectedFlow}
                  nodeId={selectedNodeId}
                  onSaved={() => void qc.invalidateQueries({ queryKey: ["flows"] })}
                />
              ) : (
                <p className="subtle">{t("auto.flows.detailEmpty")}</p>
              )
            )}
            {sideTab === "exec" && (
              selectedFlow ? (
                <ExecutionsCard client={client} jobId={selectedFlow.id} />
              ) : (
                <p className="subtle">{t("auto.flows.detailEmpty")}</p>
              )
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

/** The n8n-style flow switcher: the editor focuses on ONE flow; switching,
 * filtering, and creating live in the flow-name dropdown in the workspace
 * header. The menu stays in the DOM (visibility via the `open` class) so
 * its rows are SSR-testable and the open/close animates. */
export function FlowSwitcher({
  flows,
  selectedId,
  onSelect,
  onCreate
}: {
  flows: readonly FlowProjection[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const selected = flows.find((flow) => flow.id === selectedId);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocClick = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".flowpick")) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = flows.filter((flow) => flow.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className={`flowpick${open ? " open" : ""}`}>
      <button
        type="button"
        className="flowpick-btn"
        aria-expanded={open}
        aria-label={t("auto.flows.switcher.label")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flowpick-crumb">{t("nav.flows")} ▸</span>
        <span className="flowpick-name">{selected ? selected.name : t("auto.flows.emptyTitle")}</span>
        {selected && <span className={`dot${selected.enabled ? " on" : ""}`} />}
        <span className="flowpick-caret">▾</span>
      </button>
      <div className="flowpick-menu" role="listbox" aria-label={t("auto.flows.listTitle")}>
        <input
          className="input"
          placeholder={t("auto.flows.switcher.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="flowpick-rows">
          {visible.map((flow) => (
            <button
              type="button"
              key={flow.id}
              className={`flowpick-row${flow.id === selectedId ? " active" : ""}`}
              onClick={() => {
                onSelect(flow.id);
                setOpen(false);
              }}
            >
              <span className={`dot${flow.enabled ? " on" : ""}`} />
              <span className="flowpick-row-name">{flow.name}</span>
              <span className="flowpick-row-meta">
                {!flow.enabled
                  ? t("auto.flows.paused")
                  : flow.nextRunAtIso
                    ? formatMetaValue("nextRunAtIso", flow.nextRunAtIso, locale)
                    : ""}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="flowpick-new"
          onClick={() => {
            onCreate();
            setOpen(false);
          }}
        >
          <Icon.plus className="nav-icon" /> {t("auto.flows.create.button")}
        </button>
      </div>
    </div>
  );
}

function FlowCanvasArea({
  client,
  flow,
  onSelectNode,
  onDeselectNode
}: {
  client: ApiClient;
  flow: FlowProjection;
  onSelectNode: (id: string) => void;
  onDeselectNode: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const canvas = canvasWithNotifyGhost(flow);
  const storage = typeof window === "undefined" ? undefined : window.localStorage;
  const [notifyPickOpen, setNotifyPickOpen] = useState(false);
  const [notifyDraft, setNotifyDraft] = useState("");
  const notifyPatch = useMutation({
    mutationFn: (channelId: string) =>
      client.patch(
        `/api/scheduler/jobs/${encodeURIComponent(flow.id)}`,
        flowEditToJobPatch("output", { notificationChannelId: channelId })
      ),
    onSuccess: () => {
      setNotifyPickOpen(false);
      setNotifyDraft("");
      void qc.invalidateQueries({ queryKey: ["flows"] });
    }
  });
  const [nodes, setNodes] = useState<FlowCanvasNode[]>(() => {
    const saved = readNodePositions(storage, flow.id);
    return canvas.nodes.map((node) => ({ ...node, draggable: true, position: saved[node.id] ?? node.position }));
  });
  const [edges, setEdges] = useState<readonly FlowCanvasEdge[]>(canvas.edges);
  const [fullscreen, setFullscreen] = useState(false);

  // Escape leaves the n8n-style full-screen canvas — a fixed overlay has no
  // visible chrome to click away from, so the keyboard exit is the contract.
  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Re-render on a fresh `/api/flows` fetch (a save/toggle/trigger changed
  // the job): merge the NEW kind/label/meta/flowEnabled per node id but keep
  // whatever position the user dragged it to (in-memory first, then the
  // persisted layout) — positions are UI state, never sent to the server.
  useEffect(() => {
    setNodes((previous) => {
      const freshCanvas = canvasWithNotifyGhost(flow);
      const saved = readNodePositions(storage, flow.id);
      return freshCanvas.nodes.map((node) => {
        const existing = previous.find((candidate) => candidate.id === node.id);
        return { ...node, draggable: true, position: existing?.position ?? saved[node.id] ?? node.position };
      });
    });
    setEdges(canvasWithNotifyGhost(flow).edges);
  }, [flow]);

  const onNodesChange = (changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current) as FlowCanvasNode[]);
    // Persist only a FINISHED drag (dragging: false) — not every intermediate
    // frame, and never a programmatic dimension change.
    for (const change of changes) {
      if (change.type === "position" && change.dragging === false && change.position) {
        writeNodePosition(storage, flow.id, change.id, change.position);
      }
    }
  };

  return (
    <div className={`flow-canvas-wrap${fullscreen ? " flow-canvas-fullscreen" : ""}`}>
      <button
        type="button"
        className="flow-canvas-fs-btn"
        onClick={() => setFullscreen((on) => !on)}
        aria-pressed={fullscreen}
        aria-label={t(fullscreen ? "auto.flows.canvas.exitFullscreen" : "auto.flows.canvas.fullscreen")}
        title={t(fullscreen ? "auto.flows.canvas.exitFullscreen" : "auto.flows.canvas.fullscreen")}
      >
        {fullscreen ? <Icon.shrink /> : <Icon.expand />}
      </button>
      <ReactFlowProvider>
        <ReactFlow
          key={flow.id}
          nodes={[...nodes]}
          edges={[...edges]}
          nodeTypes={FLOW_NODE_TYPES}
          edgeTypes={FLOW_EDGE_TYPES}
          fitView
          fitViewOptions={{ maxZoom: 1.1, padding: 0.25 }}
          panOnScroll
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          deleteKeyCode={null}
          onNodesChange={onNodesChange}
          onNodeClick={(_event, node) => {
            if (isNotifyGhostId(node.id)) {
              setNotifyPickOpen(true);
              return;
            }
            onSelectNode(node.id);
          }}
          onEdgeDoubleClick={(_event, edge) => {
            if (classifyEdgeRemoval(edge, nodes) === "notify-detach") {
              notifyPatch.mutate("");
            }
          }}
          onPaneClick={onDeselectNode}
          proOptions={{ hideAttribution: true }}
        />
      </ReactFlowProvider>
      {notifyPickOpen && (
        <div className="flow-notify-pop">
          <div className="flow-notify-pop-title">{t("auto.flows.connect.pickTitle")}</div>
          <p className="subtle" style={{ margin: "0 0 8px" }}>{t("auto.flows.connect.pickHint")}</p>
          <NotifyChannelQuickPick client={client} onPick={(value) => setNotifyDraft(value)} />
          <input
            className="input"
            aria-label={t("auto.flows.connect.pickTitle")}
            placeholder="telegram:12345"
            value={notifyDraft}
            onChange={(event) => setNotifyDraft(event.target.value)}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <Button
              variant="primary"
              size="sm"
              disabled={notifyDraft.trim().length === 0 || notifyPatch.isPending}
              onClick={() => notifyPatch.mutate(notifyDraft.trim())}
            >
              {t("auto.flows.connect.attach")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setNotifyPickOpen(false)}>
              {t("auto.flows.connect.cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface TriggerResult {
  readonly result: unknown;
}

function FlowHeaderActions({
  client,
  flow,
  onDeleted,
  onDuplicated
}: {
  client: ApiClient;
  flow: FlowProjection;
  onDeleted: () => void;
  onDuplicated: (jobId: string) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const invalidateFlows = () => void qc.invalidateQueries({ queryKey: ["flows"] });
  const invalidateExecutions = () => void qc.invalidateQueries({ queryKey: executionsQueryKey(client, flow.id) });

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(flow.name);
  useEffect(() => {
    setNameDraft(flow.name);
    setRenaming(false);
  }, [flow.id, flow.name]);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    if (!confirmingDelete) {
      return;
    }
    const timer = window.setTimeout(() => setConfirmingDelete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingDelete]);

  const jobUrl = `/api/scheduler/jobs/${encodeURIComponent(flow.id)}`;

  const toggleEnabled = useMutation({
    mutationFn: () => client.patch(jobUrl, toggleEnabledPatch(!flow.enabled)),
    onSuccess: invalidateFlows
  });

  const rename = useMutation({
    mutationFn: () => client.patch(jobUrl, renameFlowPatch(nameDraft)),
    onSuccess: () => {
      setRenaming(false);
      invalidateFlows();
    }
  });

  const trigger = useMutation({
    mutationFn: () => client.post<TriggerResult>(`${jobUrl}/trigger`),
    onSuccess: () => {
      invalidateFlows();
      invalidateExecutions();
    }
  });

  const dryRun = useMutation({
    mutationFn: () => client.post<TriggerResult>(dryRunUrl(flow.id)),
    onSuccess: invalidateExecutions
  });

  const duplicate = useMutation({
    mutationFn: () =>
      client.post<{ readonly id: string }>(`${jobUrl}/duplicate`, {
        nameSuffix: t("auto.flows.header.duplicateSuffix")
      }),
    onSuccess: (created) => {
      invalidateFlows();
      onDuplicated(created.id);
    }
  });

  const remove = useMutation({
    mutationFn: () => client.del(jobUrl),
    onSuccess: () => {
      invalidateFlows();
      onDeleted();
    }
  });

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}>
        {renaming ? (
          <>
            <input
              className="input"
              style={{ maxWidth: 240 }}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={nameDraft.trim().length === 0 || rename.isPending}
              onClick={() => rename.mutate()}
            >
              {t("auto.flows.header.renameSave")}
            </Button>
          </>
        ) : (
          // The flow's name already heads the workspace (the switcher) — the
          // actions row only carries the rename affordance, not a second title.
          <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
            {t("auto.flows.header.rename")}
          </Button>
        )}
        <Button variant="secondary" size="sm" disabled={toggleEnabled.isPending} onClick={() => toggleEnabled.mutate()}>
          {t(flow.enabled ? "auto.flows.header.disable" : "auto.flows.header.enable")}
        </Button>
        <Button variant="secondary" size="sm" disabled={trigger.isPending} onClick={() => trigger.mutate()}>
          {trigger.isPending ? t("auto.flows.header.running") : t("auto.flows.header.runNow")}
        </Button>
        <Button variant="secondary" size="sm" disabled={dryRun.isPending} onClick={() => dryRun.mutate()}>
          {dryRun.isPending ? t("auto.flows.header.dryRunning") : t("auto.flows.header.dryRun")}
        </Button>
        <Button variant="secondary" size="sm" disabled={duplicate.isPending} onClick={() => duplicate.mutate()}>
          {duplicate.isPending ? t("auto.flows.header.duplicating") : t("auto.flows.header.duplicate")}
        </Button>
        <Button
          variant={confirmingDelete ? "danger" : "ghost"}
          size="sm"
          disabled={remove.isPending}
          onClick={() => {
            if (confirmingDelete) {
              remove.mutate();
            } else {
              setConfirmingDelete(true);
            }
          }}
        >
          <Icon.trash className="nav-icon" /> {confirmingDelete ? t("auto.flows.header.deleteConfirm") : t("auto.flows.header.delete")}
        </Button>
      </div>
      {rename.error && <div className="banner err">{errorMessage(rename.error, t("auto.flows.header.renameFailed"))}</div>}
      {trigger.isSuccess && (
        <div className="banner">{t("auto.flows.header.runResult", { status: describeTriggerResult(trigger.data) })}</div>
      )}
      {trigger.error && <div className="banner err">{errorMessage(trigger.error, t("auto.flows.header.runFailed"))}</div>}
      {dryRun.isSuccess && (
        <div className="banner">{t("auto.flows.header.dryRunResult", { status: describeTriggerResult(dryRun.data) })}</div>
      )}
      {dryRun.error && <div className="banner err">{errorMessage(dryRun.error, t("auto.flows.header.dryRunFailed"))}</div>}
      {duplicate.error && <div className="banner err">{errorMessage(duplicate.error, t("auto.flows.header.duplicateFailed"))}</div>}
      {remove.error && <div className="banner err">{errorMessage(remove.error, t("auto.flows.header.deleteFailed"))}</div>}
    </div>
  );
}

function describeTriggerResult(data: TriggerResult | undefined): string {
  if (!data) {
    return "";
  }
  return typeof data.result === "string" ? data.result : JSON.stringify(data.result);
}

function FlowNodeDetailHost({
  client,
  flow,
  nodeId,
  onSaved
}: {
  client: ApiClient;
  flow: FlowProjection;
  nodeId: string;
  onSaved: () => void;
}) {
  const canvas = flowToCanvas(flow);
  const node = canvas.nodes.find((candidate) => candidate.id === nodeId);
  const { t } = useI18n();

  if (!node) {
    return <p className="subtle">{t("auto.flows.detailEmpty")}</p>;
  }

  return <FlowNodeEditPanel client={client} jobId={flow.id} node={node} onSaved={onSaved} />;
}
