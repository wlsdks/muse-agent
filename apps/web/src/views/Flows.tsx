import { useQuery } from "@tanstack/react-query";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useEffect, useState } from "react";

import "@xyflow/react/dist/style.css";

import { AsyncBlock, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { flowToCanvas } from "./flow-canvas-mapping.js";
import { FLOW_EDGE_TYPES } from "./flow-edges.js";
import { formatMetaValue, KIND_LABEL_KEY, META_LABEL_KEY, FLOW_NODE_TYPES } from "./flow-nodes.js";

import type { FlowCanvasNode } from "./flow-canvas-mapping.js";
import type { ApiClient } from "../api/client.js";
import type { FlowProjection, FlowsResponse } from "../api/types.js";

export function FlowsTab({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const q = useQuery({
    queryFn: () => client.get<FlowsResponse>("/api/flows"),
    queryKey: ["flows", client.baseUrl]
  });
  const flows = q.data?.flows ?? [];

  return (
    <AsyncBlock
      loading={q.isLoading}
      error={q.error}
      empty={flows.length === 0}
      emptyIcon={<Icon.activity />}
      emptyLabel={t("auto.flows.emptyTitle")}
      emptyHint={t("auto.flows.emptyHint")}
    >
      <FlowsBody flows={flows} />
    </AsyncBlock>
  );
}

function FlowsBody({ flows }: { flows: readonly FlowProjection[] }) {
  const { t, locale } = useI18n();
  const [selectedFlowId, setSelectedFlowId] = useState<string | undefined>(flows[0]?.id);
  const [selectedNode, setSelectedNode] = useState<FlowCanvasNode | undefined>(undefined);

  const selectedFlow = flows.find((flow) => flow.id === selectedFlowId) ?? flows[0];

  useEffect(() => {
    setSelectedNode(undefined);
  }, [selectedFlow?.id]);

  if (!selectedFlow) {
    return null;
  }

  const canvas = flowToCanvas(selectedFlow);
  const nodes = [...canvas.nodes];
  const edges = [...canvas.edges];

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "280px 1fr" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Card title={t("auto.flows.listTitle")} count={flows.length}>
          <div className="flow-list">
            {flows.map((flow) => (
              <button
                type="button"
                key={flow.id}
                className={`flow-list-item${flow.id === selectedFlow.id ? " active" : ""}`}
                onClick={() => setSelectedFlowId(flow.id)}
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
        <Card title={t("auto.flows.detailTitle")}>
          {selectedNode ? <FlowNodeDetail node={selectedNode} /> : <p className="subtle">{t("auto.flows.detailEmpty")}</p>}
        </Card>
      </div>

      <div className="flow-canvas-wrap">
        <ReactFlowProvider>
          <ReactFlow
            key={selectedFlow.id}
            nodes={nodes}
            edges={edges}
            nodeTypes={FLOW_NODE_TYPES}
            edgeTypes={FLOW_EDGE_TYPES}
            fitView
            panOnScroll
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            deleteKeyCode={null}
            onNodeClick={(_event, node) => setSelectedNode(node)}
            onPaneClick={() => setSelectedNode(undefined)}
            proOptions={{ hideAttribution: true }}
          />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

function FlowNodeDetail({ node }: { node: FlowCanvasNode }) {
  const { locale, t } = useI18n();
  const entries = Object.entries(node.data.meta)
    .map(([key, value]) => ({ key, value: formatMetaValue(key, value, locale) }))
    .filter((entry): entry is { key: string; value: string } => entry.value !== null);

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div className="row-title">{t(KIND_LABEL_KEY[node.data.kind])}</div>
      {entries.length === 0 && <p className="subtle">{t("auto.flows.detailEmpty")}</p>}
      {entries.map((entry) => (
        <div className="row-meta" key={entry.key}>
          {t(META_LABEL_KEY[entry.key] ?? "auto.flows.meta.prompt")}: {entry.value}
        </div>
      ))}
    </div>
  );
}
