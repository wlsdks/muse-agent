import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";

import type { FlowCanvasEdgeData } from "./flow-canvas-mapping.js";

// Same reasoning as `flow-nodes.tsx`'s `FlowNodeProps`: `edgeTypes`'s
// registration needs the library's general (untyped-`type`) `Edge` shape.
type FlowEdgeProps = EdgeProps<Edge<FlowCanvasEdgeData>>;

/**
 * The one custom edge every flow-canvas connection renders through. A
 * straight trigger->action->output hop is a plain bezier; a retry loop
 * (`data.loop`) draws a self-connecting arc above the node — the official
 * React Flow self-connecting-edge recipe (`A {rx} {ry} 0 1 0 {x} {y}`),
 * since `getBezierPath` degenerates to a point when source === target.
 */
export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  data
}: FlowEdgeProps) {
  const enabled = data?.flowEnabled ?? true;
  const loop = data?.loop ?? false;
  const stroke = enabled ? "var(--flow-edge-enabled)" : "var(--flow-edge-disabled)";

  if (loop) {
    const radiusX = 46;
    const radiusY = 38;
    const path = `M ${sourceX} ${sourceY - 4} A ${radiusX} ${radiusY} 0 1 0 ${targetX} ${targetY + 4}`;
    const labelX = sourceX;
    const labelY = sourceY - radiusY - 14;
    return (
      <>
        <BaseEdge id={id} path={path} style={{ stroke, strokeDasharray: "4 3", strokeWidth: 1.5 }} />
        {label && (
          <EdgeLabelRenderer>
            <div
              className="flow-edge-label"
              style={{ transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY}px)` }}
            >
              {label}
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  }

  const [path] = getBezierPath({ sourcePosition, sourceX, sourceY, targetPosition, targetX, targetY });
  return <BaseEdge id={id} path={path} style={{ stroke, strokeWidth: 1.5 }} />;
}

export const FLOW_EDGE_TYPES = { flowEdge: FlowEdge };
