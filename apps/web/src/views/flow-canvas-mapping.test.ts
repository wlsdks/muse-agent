import { describe, expect, it } from "vitest";

import { flowToCanvas } from "./flow-canvas-mapping.js";

import type { FlowProjection } from "../api/types.js";

const BASE_FLOW: FlowProjection = {
  edges: [
    { from: "job_1::trigger", id: "job_1::edge-trigger-action", to: "job_1::action" },
    { from: "job_1::action", id: "job_1::edge-action-output", to: "job_1::output" }
  ],
  enabled: true,
  id: "job_1",
  name: "Morning brief",
  nextRunAtIso: "2026-07-18T09:00:00.000Z",
  nodes: [
    {
      id: "job_1::trigger",
      kind: "trigger.schedule",
      label: "trigger.schedule",
      meta: { cronExpression: "0 9 * * *", nextRunAtIso: "2026-07-18T09:00:00.000Z", timezone: "UTC" }
    },
    {
      id: "job_1::action",
      kind: "action.agent",
      label: "action.agent",
      meta: { maxToolCalls: null, model: null, prompt: "오늘 일정 요약해서 보내줘" }
    },
    { id: "job_1::output", kind: "output.record", label: "output.record", meta: {} }
  ],
  source: "scheduler"
};

describe("flowToCanvas — node positions + ids", () => {
  it("places trigger/action/output at deterministic x positions on the same row", () => {
    const canvas = flowToCanvas(BASE_FLOW);
    expect(canvas.nodes).toHaveLength(3);
    expect(canvas.nodes[0]).toMatchObject({ id: "job_1::trigger", position: { x: 0, y: 0 } });
    expect(canvas.nodes[1]).toMatchObject({ id: "job_1::action", position: { x: 340, y: 0 } });
    expect(canvas.nodes[2]).toMatchObject({ id: "job_1::output", position: { x: 680, y: 0 } });
  });

  it("assigns the node type by category (trigger/action/output), regardless of the underlying kind", () => {
    const canvas = flowToCanvas(BASE_FLOW);
    expect(canvas.nodes[0]!.type).toBe("triggerNode");
    expect(canvas.nodes[1]!.type).toBe("actionNode");
    expect(canvas.nodes[2]!.type).toBe("outputNode");

    const toolFlow: FlowProjection = {
      ...BASE_FLOW,
      nodes: [
        BASE_FLOW.nodes[0]!,
        { id: "job_1::action", kind: "action.tool", label: "action.tool", meta: { server: "notion", tool: "x" } },
        { id: "job_1::output", kind: "output.webhook", label: "output.webhook", meta: { url: "example.com" } }
      ]
    };
    const toolCanvas = flowToCanvas(toolFlow);
    expect(toolCanvas.nodes[1]!.type).toBe("actionNode");
    expect(toolCanvas.nodes[2]!.type).toBe("outputNode");
  });

  it("carries the real kind/label/meta through unchanged", () => {
    const canvas = flowToCanvas(BASE_FLOW);
    expect(canvas.nodes[1]!.data).toMatchObject({
      kind: "action.agent",
      label: "action.agent",
      meta: { maxToolCalls: null, model: null, prompt: "오늘 일정 요약해서 보내줘" }
    });
  });

  it("is stable across repeated calls (same projection -> same ids/positions)", () => {
    const first = flowToCanvas(BASE_FLOW);
    const second = flowToCanvas(BASE_FLOW);
    expect(second).toEqual(first);
  });

  it("marks nodes read-only: not draggable, not connectable", () => {
    const canvas = flowToCanvas(BASE_FLOW);
    for (const node of canvas.nodes) {
      expect(node.draggable).toBe(false);
      expect(node.connectable).toBe(false);
    }
  });
});

describe("flowToCanvas — disabled flow", () => {
  it("marks every node's flowEnabled false and shows the disabled badge ONLY on the trigger node", () => {
    const canvas = flowToCanvas({ ...BASE_FLOW, enabled: false });
    for (const node of canvas.nodes) {
      expect(node.data.flowEnabled).toBe(false);
    }
    expect(canvas.nodes[0]!.data.showDisabledBadge).toBe(true);
    expect(canvas.nodes[1]!.data.showDisabledBadge).toBe(false);
    expect(canvas.nodes[2]!.data.showDisabledBadge).toBe(false);
  });

  it("an enabled flow shows no disabled badge on any node — mutation-RED case: flip the badge condition", () => {
    const canvas = flowToCanvas(BASE_FLOW);
    expect(canvas.nodes.every((node) => !node.data.showDisabledBadge)).toBe(true);
  });
});

describe("flowToCanvas — edges", () => {
  it("maps the linear trigger -> action -> output edges with no loop flag", () => {
    const canvas = flowToCanvas(BASE_FLOW);
    expect(canvas.edges).toHaveLength(2);
    expect(canvas.edges[0]).toMatchObject({ source: "job_1::trigger", target: "job_1::action" });
    expect(canvas.edges[0]!.data?.loop).toBe(false);
    expect(canvas.edges[1]).toMatchObject({ source: "job_1::action", target: "job_1::output" });
  });

  it("maps a retry self-edge to a source===target connection carrying its label + loop flag", () => {
    const flowWithRetry: FlowProjection = {
      ...BASE_FLOW,
      edges: [
        ...BASE_FLOW.edges,
        { from: "job_1::action", id: "job_1::edge-retry", label: "실패 시 재시도 ×3", loop: true, to: "job_1::action" }
      ]
    };
    const canvas = flowToCanvas(flowWithRetry);
    const loopEdge = canvas.edges.find((edge) => edge.data?.loop);
    expect(loopEdge).toBeDefined();
    expect(loopEdge!.source).toBe(loopEdge!.target);
    expect(loopEdge!.source).toBe("job_1::action");
    expect(loopEdge!.label).toBe("실패 시 재시도 ×3");
  });
});
