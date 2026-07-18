import { useMutation, useQueryClient } from "@tanstack/react-query";
import { applyNodeChanges, ReactFlow, ReactFlowProvider, type NodeChange } from "@xyflow/react";
import { useEffect, useState } from "react";

import "@xyflow/react/dist/style.css";

import { Button, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { safeLocalStorage } from "../lib/safe-storage.js";
import { canvasWithNotifyGhost, classifyEdgeRemoval, isNotifyGhostId } from "./flow-connection-logic.js";
import { readNodePositions, writeNodePosition } from "./flow-node-positions.js";
import { FLOW_EDGE_TYPES } from "./flow-edges.js";
import { flowEditToJobPatch } from "./flow-edit-compile.js";
import { NotifyChannelQuickPick } from "./flow-notify-picker.js";
import { FLOW_NODE_TYPES } from "./flow-nodes.js";

import type { FlowCanvasEdge, FlowCanvasNode } from "./flow-canvas-mapping.js";
import type { ApiClient } from "../api/client.js";
import type { FlowProjection } from "../api/types.js";

export function FlowCanvasArea({
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
  const storage = safeLocalStorage();
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
    const freshCanvas = canvasWithNotifyGhost(flow);
    setNodes((previous) => {
      const saved = readNodePositions(storage, flow.id);
      return freshCanvas.nodes.map((node) => {
        const existing = previous.find((candidate) => candidate.id === node.id);
        return { ...node, draggable: true, position: existing?.position ?? saved[node.id] ?? node.position };
      });
    });
    setEdges(freshCanvas.edges);
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
