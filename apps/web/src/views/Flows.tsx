import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applyNodeChanges, ReactFlow, ReactFlowProvider, type NodeChange } from "@xyflow/react";
import { useEffect, useState } from "react";
import { errorMessage } from "@muse/shared/browser";

import "@xyflow/react/dist/style.css";

import { AsyncBlock, Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { flowToCanvas } from "./flow-canvas-mapping.js";
import { FLOW_EDGE_TYPES } from "./flow-edges.js";
import { flowDraftToCopilotPayload, renameFlowPatch, toggleEnabledPatch } from "./flow-edit-compile.js";
import { FlowCreatePanel } from "./flow-create-panel.js";
import { FlowDraftComposer } from "./flow-draft-composer.js";
import { FlowNodeEditPanel } from "./flow-edit-panel.js";
import { dryRunUrl } from "./flow-executions-compile.js";
import { ExecutionsCard, executionsQueryKey } from "./flow-executions.js";
import { formatMetaValue, FLOW_NODE_TYPES } from "./flow-nodes.js";

import type { FlowCanvasEdge, FlowCanvasNode } from "./flow-canvas-mapping.js";
import type { FlowDraft } from "./flow-edit-compile.js";
import type { ApiClient } from "../api/client.js";
import type { FlowDraftPayloadRow, FlowProjection, FlowsResponse } from "../api/types.js";


export function FlowsView({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.workspace")}</p>
      <h1 className="page-title">{t("nav.flows")}</h1>
      <p className="muted" style={{ marginTop: 4, marginBottom: 16 }}>{t("flows.subtitle")}</p>
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

function FlowsBody({ client, flows }: { client: ApiClient; flows: readonly FlowProjection[] }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [selectedFlowId, setSelectedFlowId] = useState<string | undefined>(flows[0]?.id);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [initialDraft, setInitialDraft] = useState<FlowDraftPayloadRow | undefined>(undefined);
  const [draftVersion, setDraftVersion] = useState(0);
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
  };
  // Tool-mode drafts are authored directly in the create form (server/tool
  // pickers), not through the copilot — the composer only ever produces an
  // agent-prompt draft, so it's disabled with an honest note while the form
  // is in tool mode rather than silently ignoring a chat message.
  const currentDraft = creating && liveDraft && liveDraft.actionKind === "agent"
    ? flowDraftToCopilotPayload(liveDraft)
    : undefined;
  const composerDisabledNote = creating && liveDraft?.actionKind === "tool"
    ? t("auto.flows.draft.disabledForTool")
    : undefined;

  if (creating) {
    return (
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "280px 1fr" }}>
        <FlowListCard
          client={client}
          flows={flows}
          onDrafted={handleDrafted}
          currentDraft={currentDraft}
          composerDisabledNote={composerDisabledNote}
          selectedId={selectedFlow?.id}
          onSelect={(id) => {
            setSelectedFlowId(id);
            closeCreatePanel();
          }}
          onCreate={openCreatePanel}
        />
        <FlowCreatePanel
          key={initialDraft ? `draft-${draftVersion.toString()}` : "empty"}
          client={client}
          initialDraft={initialDraft}
          onDraftChange={setLiveDraft}
          onCancel={closeCreatePanel}
          onCreated={(jobId) => {
            closeCreatePanel();
            setSelectedFlowId(jobId);
          }}
        />
      </div>
    );
  }

  if (!selectedFlow) {
    // Zero flows must still offer the create entry point — routing this
    // through AsyncBlock's generic empty state hid the whole body, so a
    // first-run user could only create a flow from the CLI.
    return (
      <div className="empty-block" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "40px 0" }}>
        <Icon.activity className="nav-icon" />
        <div style={{ fontWeight: 600 }}>{t("auto.flows.emptyTitle")}</div>
        <div className="muted" style={{ fontSize: 13, maxWidth: 420, textAlign: "center" }}>{t("auto.flows.emptyHint")}</div>
        <Button variant="primary" size="sm" onClick={openCreatePanel}>
          <Icon.plus className="nav-icon" /> {t("auto.flows.create.button")}
        </Button>
        <div style={{ width: "100%", maxWidth: 460, marginTop: 8 }}>
          <FlowDraftComposer client={client} onDrafted={handleDrafted} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "280px 1fr" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <FlowListCard
          client={client}
          flows={flows}
          onDrafted={handleDrafted}
          selectedId={selectedFlow.id}
          onSelect={setSelectedFlowId}
          onCreate={openCreatePanel}
        />
        <Card title={t("auto.flows.detailTitle")}>
          {selectedNodeId ? (
            <FlowNodeDetailHost
              client={client}
              flow={selectedFlow}
              nodeId={selectedNodeId}
              onSaved={() => void qc.invalidateQueries({ queryKey: ["flows"] })}
            />
          ) : (
            <p className="subtle">{t("auto.flows.detailEmpty")}</p>
          )}
        </Card>
        <ExecutionsCard client={client} jobId={selectedFlow.id} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <FlowHeaderActions
          client={client}
          flow={selectedFlow}
          onDeleted={() => {
            setSelectedFlowId(flows.find((flow) => flow.id !== selectedFlow.id)?.id);
          }}
          onDuplicated={(jobId) => setSelectedFlowId(jobId)}
        />
        <FlowCanvasArea
          flow={selectedFlow}
          onSelectNode={(id) => setSelectedNodeId(id)}
          onDeselectNode={() => setSelectedNodeId(undefined)}
        />
      </div>
    </div>
  );
}

function FlowListCard({
  client,
  flows,
  selectedId,
  onSelect,
  onCreate,
  onDrafted,
  currentDraft,
  composerDisabledNote
}: {
  client: ApiClient;
  flows: readonly FlowProjection[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDrafted: (draft: FlowDraftPayloadRow) => void;
  /** Present only while the create panel is open — turns the composer into
   * a revision turn against the panel's LIVE form values. */
  currentDraft?: FlowDraftPayloadRow;
  /** Present only while the create panel is in TOOL mode — replaces the
   * composer with an honest one-line note instead of a chat box that would
   * silently do nothing (the copilot only drafts agent flows). */
  composerDisabledNote?: string;
}) {
  const { t, locale } = useI18n();
  return (
    <Card
      title={t("auto.flows.listTitle")}
      count={flows.length}
      action={
        <Button variant="ghost" size="sm" onClick={onCreate}>
          <Icon.plus className="nav-icon" /> {t("auto.flows.create.button")}
        </Button>
      }
    >
      {composerDisabledNote
        ? <div className="banner" style={{ marginBottom: 10 }}>{composerDisabledNote}</div>
        : <FlowDraftComposer client={client} onDrafted={onDrafted} currentDraft={currentDraft} />}
      <div className="flow-list">
        {flows.map((flow) => (
          <button
            type="button"
            key={flow.id}
            className={`flow-list-item${flow.id === selectedId ? " active" : ""}`}
            onClick={() => onSelect(flow.id)}
          >
            <span className={`dot${flow.enabled ? " on" : ""}`} />
            <span className="flow-list-item-main">
              <span className="flow-list-item-title">{flow.name}</span>
              <span className="flow-list-item-meta">
                {flow.nextRunAtIso ? formatMetaValue("nextRunAtIso", flow.nextRunAtIso, locale) : t("auto.flows.selectHint")}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function FlowCanvasArea({
  flow,
  onSelectNode,
  onDeselectNode
}: {
  flow: FlowProjection;
  onSelectNode: (id: string) => void;
  onDeselectNode: () => void;
}) {
  const { t } = useI18n();
  const canvas = flowToCanvas(flow);
  const [nodes, setNodes] = useState<FlowCanvasNode[]>(() => canvas.nodes.map((node) => ({ ...node, draggable: true })));
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
  // whatever position the user dragged it to — positions are ephemeral UI
  // state, never sent to the server.
  useEffect(() => {
    setNodes((previous) => {
      const freshCanvas = flowToCanvas(flow);
      return freshCanvas.nodes.map((node) => {
        const existing = previous.find((candidate) => candidate.id === node.id);
        return { ...node, draggable: true, position: existing?.position ?? node.position };
      });
    });
    setEdges(flowToCanvas(flow).edges);
  }, [flow]);

  const onNodesChange = (changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current) as FlowCanvasNode[]);
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
          onNodeClick={(_event, node) => onSelectNode(node.id)}
          onPaneClick={onDeselectNode}
          proOptions={{ hideAttribution: true }}
        />
      </ReactFlowProvider>
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
          <>
            <h2 className="page-title" style={{ fontSize: 20, margin: 0 }}>{flow.name}</h2>
            <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
              {t("auto.flows.header.rename")}
            </Button>
          </>
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
