/**
 * Pure canvas-connection semantics: the ONLY edge with runner-backed meaning
 * today is action → output.notify (the job's notificationChannelId). This
 * module decides where the notify GHOST node appears (a flow with no
 * channel gets a click-to-connect placeholder) and which edge gestures are
 * meaningful (double-click on the notify edge = detach). No React, no
 * xyflow imports — unit-testable canvas policy.
 */

import { flowToCanvas } from "./flow-canvas-mapping.js";

import type { FlowCanvas, FlowCanvasEdge, FlowCanvasNode } from "./flow-canvas-mapping.js";
import type { FlowProjection } from "../api/types.js";

const GHOST_SUFFIX = "::notify-ghost";

export function notifyGhostId(flowId: string): string {
  return `${flowId}${GHOST_SUFFIX}`;
}

export function isNotifyGhostId(nodeId: string): boolean {
  return nodeId.endsWith(GHOST_SUFFIX);
}

/**
 * The canvas for a flow, plus a notify ghost node when (and only when) the
 * flow has no output.notify node — the placeholder the user clicks to
 * connect a notification channel. The ghost is UI-only: never sent to the
 * server, id stable per flow so dragged positions persist.
 */
export function canvasWithNotifyGhost(flow: FlowProjection): FlowCanvas {
  const base = flowToCanvas(flow);
  const notifyIds = new Set(base.nodes.filter((node) => node.data.kind === "output.notify").map((node) => node.id));
  // Mark the detachable notify edge so the renderer can carry the
  // double-click affordance (SVG title) — the gesture must be discoverable.
  const canvas: FlowCanvas = {
    edges: base.edges.map((edge) => (notifyIds.has(edge.target) ? { ...edge, data: { ...edge.data!, detachable: true } } : edge)),
    nodes: base.nodes
  };
  if (notifyIds.size > 0) {
    return canvas;
  }
  // Never overlap a real node (the no-overlap canvas rule): drop the ghost
  // one row (140px) below the lowest node in the output column, floored at
  // the layout's own output slot (680, 220) for the plain 2-node flow.
  const lowestInColumn = Math.max(
    80,
    ...canvas.nodes.filter((node) => node.position.x >= 680).map((node) => node.position.y)
  );
  const ghost: FlowCanvasNode = {
    data: {
      flowEnabled: flow.enabled,
      ghost: true,
      kind: "output.notify",
      label: "output.notify",
      meta: {},
      showDisabledBadge: false
    },
    id: notifyGhostId(flow.id),
    position: { x: 680, y: Math.max(220, lowestInColumn + 140) },
    type: "outputNode"
  };
  return { edges: canvas.edges, nodes: [...canvas.nodes, ghost] };
}

/**
 * Meaningful edge-removal gestures: double-clicking the edge INTO the real
 * output.notify node detaches the notification channel (PATCH
 * notificationChannelId null). Structural edges (trigger→action, retry
 * self-loop) and anything targeting a ghost stay inert.
 */
export function classifyEdgeRemoval(
  edge: Pick<FlowCanvasEdge, "target">,
  nodes: readonly FlowCanvasNode[]
): "notify-detach" | "keep" {
  const target = nodes.find((node) => node.id === edge.target);
  if (!target || target.data.ghost === true) {
    return "keep";
  }
  return target.data.kind === "output.notify" ? "notify-detach" : "keep";
}

/**
 * Drag-connect gate: the ONE meaningful user-drawn edge is action → notify
 * GHOST (attach a channel). A real output.notify already has its edge, and
 * every other pair is structural — rejected, so the canvas can never draw a
 * connection the runner wouldn't honor.
 */
export function classifyConnection(
  sourceId: string | null,
  targetId: string | null,
  nodes: readonly FlowCanvasNode[]
): "notify-attach" | "reject" {
  if (!sourceId || !targetId) {
    return "reject";
  }
  const source = nodes.find((node) => node.id === sourceId);
  if (!source || !source.data.kind.startsWith("action.")) {
    return "reject";
  }
  return isNotifyGhostId(targetId) ? "notify-attach" : "reject";
}
