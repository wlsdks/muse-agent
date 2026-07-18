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
  const canvas = flowToCanvas(flow);
  if (canvas.nodes.some((node) => node.data.kind === "output.notify")) {
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
