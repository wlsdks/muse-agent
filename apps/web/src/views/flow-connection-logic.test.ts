import { describe, expect, it } from "vitest";

import { canvasWithNotifyGhost, classifyEdgeRemoval, isNotifyGhostId, notifyGhostId } from "./flow-connection-logic.js";

import type { FlowProjection } from "../api/types.js";

function flowWith(nodes: FlowProjection["nodes"], edges: FlowProjection["edges"] = []): FlowProjection {
  return {
    edges,
    enabled: true,
    id: "flow-1",
    name: "테스트 흐름",
    nextRunAtIso: null,
    nodes
  } as unknown as FlowProjection;
}

const TRIGGER = { id: "flow-1::trigger", kind: "trigger.schedule", label: "trigger.schedule", meta: {} } as const;
const ACTION = { id: "flow-1::action", kind: "action.agent", label: "action.agent", meta: { prompt: "요약" } } as const;
const OUTPUT = { id: "flow-1::output", kind: "output.notify", label: "output.notify", meta: { channelId: "telegram:1" } } as const;

describe("canvasWithNotifyGhost", () => {
  it("appends a click-to-connect ghost when the flow has no notify output", () => {
    const canvas = canvasWithNotifyGhost(flowWith([TRIGGER, ACTION]));
    const ghost = canvas.nodes.find((node) => node.id === notifyGhostId("flow-1"));
    expect(ghost).toBeDefined();
    expect(ghost?.data.ghost).toBe(true);
    expect(ghost?.data.kind).toBe("output.notify");
  });

  it("never overlaps an existing node in the output column", () => {
    const third = { id: "flow-1::exec", kind: "output.record", label: "output.record", meta: {} } as const;
    const canvas = canvasWithNotifyGhost(flowWith([TRIGGER, ACTION, third]));
    const ghost = canvas.nodes.find((node) => isNotifyGhostId(node.id));
    expect(ghost).toBeDefined();
    const others = canvas.nodes.filter((node) => node !== ghost);
    expect(others.some((node) => node.position.x === ghost!.position.x && node.position.y === ghost!.position.y)).toBe(false);
  });

  it("adds NO ghost when a real notify output exists", () => {
    const canvas = canvasWithNotifyGhost(flowWith([TRIGGER, ACTION, OUTPUT]));
    expect(canvas.nodes.some((node) => node.data.ghost === true)).toBe(false);
    expect(canvas.nodes.some((node) => isNotifyGhostId(node.id))).toBe(false);
  });
});

describe("classifyEdgeRemoval", () => {
  it("classifies the edge into the real notify node as detachable", () => {
    const canvas = canvasWithNotifyGhost(
      flowWith([TRIGGER, ACTION, OUTPUT], [{ from: ACTION.id, id: "e1", to: OUTPUT.id }])
    );
    const notifyEdge = canvas.edges.find((edge) => edge.target === OUTPUT.id);
    expect(notifyEdge).toBeDefined();
    expect(classifyEdgeRemoval(notifyEdge!, canvas.nodes)).toBe("notify-detach");
  });

  it("keeps the structural trigger→action edge inert", () => {
    const canvas = canvasWithNotifyGhost(
      flowWith([TRIGGER, ACTION, OUTPUT], [{ from: TRIGGER.id, id: "e0", to: ACTION.id }, { from: ACTION.id, id: "e1", to: OUTPUT.id }])
    );
    const structural = canvas.edges.find((edge) => edge.target === ACTION.id);
    expect(classifyEdgeRemoval(structural!, canvas.nodes)).toBe("keep");
  });

  it("keeps an edge whose target is missing or a ghost", () => {
    const canvas = canvasWithNotifyGhost(flowWith([TRIGGER, ACTION]));
    expect(classifyEdgeRemoval({ target: "nope" }, canvas.nodes)).toBe("keep");
    expect(classifyEdgeRemoval({ target: notifyGhostId("flow-1") }, canvas.nodes)).toBe("keep");
  });
});
