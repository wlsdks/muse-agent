/**
 * Pure mapper: `FlowProjection` (the server's read-only scheduler
 * projection) → React Flow's `nodes`/`edges` shape. No rendering, no
 * randomness — same projection always yields the same ids and positions,
 * which is what makes `fitView` + node selection stable across re-fetches.
 */

import type { Edge, Node } from "@xyflow/react";

import type { FlowEdge, FlowNode, FlowNodeKind, FlowProjection } from "../api/types.js";

const COLUMN_X: Record<0 | 1 | 2, number> = { 0: 0, 1: 340, 2: 680 };
const ROW_Y = 0;

export interface FlowCanvasNodeData extends Record<string, unknown> {
  readonly kind: FlowNodeKind;
  readonly label: string;
  readonly meta: Record<string, string | number | boolean | null>;
  readonly flowEnabled: boolean;
  readonly showDisabledBadge: boolean;
}

export type FlowCanvasNodeType = "triggerNode" | "actionNode" | "outputNode";

export type FlowCanvasNode = Node<FlowCanvasNodeData, FlowCanvasNodeType>;

export interface FlowCanvasEdgeData extends Record<string, unknown> {
  readonly flowEnabled: boolean;
  readonly loop: boolean;
}

export type FlowCanvasEdge = Edge<FlowCanvasEdgeData, "flowEdge">;

export interface FlowCanvas {
  readonly nodes: readonly FlowCanvasNode[];
  readonly edges: readonly FlowCanvasEdge[];
}

/** Maps one flow's real nodes/edges to a React Flow canvas — trigger, then
 * action, then output, left to right; a retry loop stays a self-edge. */
export function flowToCanvas(flow: FlowProjection): FlowCanvas {
  const nodes = flow.nodes.map((node, index) => toCanvasNode(node, index, flow.enabled));
  const edges = flow.edges.map((edge) => toCanvasEdge(edge, flow.enabled));
  return { edges, nodes };
}

function toCanvasNode(node: FlowNode, index: number, flowEnabled: boolean): FlowCanvasNode {
  const column = (Math.min(index, 2) as 0 | 1 | 2);
  return {
    connectable: false,
    data: {
      flowEnabled,
      kind: node.kind,
      label: node.label,
      meta: node.meta,
      showDisabledBadge: !flowEnabled && node.kind === "trigger.schedule"
    },
    draggable: false,
    id: node.id,
    position: { x: COLUMN_X[column], y: ROW_Y },
    type: nodeTypeForKind(node.kind)
  };
}

function nodeTypeForKind(kind: FlowNodeKind): FlowCanvasNodeType {
  if (kind === "trigger.schedule") return "triggerNode";
  if (kind === "action.agent" || kind === "action.tool") return "actionNode";
  return "outputNode";
}

function toCanvasEdge(edge: FlowEdge, flowEnabled: boolean): FlowCanvasEdge {
  const loop = edge.loop === true;
  return {
    data: { flowEnabled, loop },
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: "flowEdge",
    ...(edge.label ? { label: edge.label } : {})
  };
}
