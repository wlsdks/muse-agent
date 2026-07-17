import { ReactFlowProvider } from "@xyflow/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActionNode, OutputNode, TriggerNode } from "./flow-nodes.js";
import { I18nProvider } from "../i18n/index.js";

import type { FlowCanvasNodeData } from "./flow-canvas-mapping.js";
import type { ComponentProps } from "react";

const REQUIRED_NODE_PROPS = {
  deletable: true,
  dragging: false,
  draggable: false,
  isConnectable: false,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  selectable: true,
  zIndex: 0
} as const;

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <ReactFlowProvider>{node}</ReactFlowProvider>
    </I18nProvider>
  );
}

const TRIGGER_DATA: FlowCanvasNodeData = {
  flowEnabled: true,
  kind: "trigger.schedule",
  label: "trigger.schedule",
  meta: { cronExpression: "0 9 * * *", nextRunAtIso: "2026-07-18T09:00:00.000Z", timezone: "UTC" },
  showDisabledBadge: false
};

const ACTION_DATA: FlowCanvasNodeData = {
  flowEnabled: true,
  kind: "action.agent",
  label: "action.agent",
  meta: { maxToolCalls: null, model: "ollama/gemma4:12b", prompt: "오늘 일정 요약해서 보내줘" },
  showDisabledBadge: false
};

const OUTPUT_DATA: FlowCanvasNodeData = {
  flowEnabled: true,
  kind: "output.notify",
  label: "output.notify",
  meta: { channelId: "telegram:12345" },
  showDisabledBadge: false
};

function triggerProps(overrides: Partial<ComponentProps<typeof TriggerNode>> = {}) {
  return { ...REQUIRED_NODE_PROPS, data: TRIGGER_DATA, id: "n1", selected: false, type: "triggerNode", ...overrides };
}

describe("TriggerNode", () => {
  it("renders the trigger icon, eyebrow, kind label, and cron/timezone/next-run meta chips", () => {
    const html = render(<TriggerNode {...triggerProps()} />);
    expect(html).toContain("flow-node");
    expect(html).toContain("Trigger");
    expect(html).toContain("Schedule trigger");
    expect(html).toContain("0 9 * * *");
    expect(html).toContain("UTC");
  });

  it("shows the disabled badge only when data.showDisabledBadge is true", () => {
    const on = render(<TriggerNode {...triggerProps({ data: { ...TRIGGER_DATA, showDisabledBadge: true } })} />);
    expect(on).toContain("flow-node-badge");
    const off = render(<TriggerNode {...triggerProps()} />);
    expect(off).not.toContain("flow-node-badge");
  });

  it("renders at reduced opacity when flowEnabled is false", () => {
    const html = render(<TriggerNode {...triggerProps({ data: { ...TRIGGER_DATA, flowEnabled: false } })} />);
    expect(html).toContain("opacity:0.55");
  });
});

describe("ActionNode", () => {
  it("renders the agent kind label and the real prompt/model meta, dropping null fields", () => {
    const html = render(
      <ActionNode {...REQUIRED_NODE_PROPS} data={ACTION_DATA} id="n2" selected={false} type="actionNode" />
    );
    expect(html).toContain("Agent run");
    expect(html).toContain("오늘 일정 요약해서 보내줘");
    expect(html).toContain("ollama/gemma4:12b");
    expect(html).not.toContain("Max tool calls");
  });

  it("carries the selected class when selected is true — the border/shadow hook", () => {
    const html = render(
      <ActionNode {...REQUIRED_NODE_PROPS} data={ACTION_DATA} id="n2" selected type="actionNode" />
    );
    expect(html).toMatch(/class="flow-node selected"/);
  });
});

describe("OutputNode", () => {
  it("renders the notify kind label and the real channel id", () => {
    const html = render(
      <OutputNode {...REQUIRED_NODE_PROPS} data={OUTPUT_DATA} id="n3" selected={false} type="outputNode" />
    );
    expect(html).toContain("Notification");
    expect(html).toContain("telegram:12345");
  });

  it("renders no meta chips for an output.record node (empty meta)", () => {
    const html = render(
      <OutputNode
        {...REQUIRED_NODE_PROPS}
        data={{ flowEnabled: true, kind: "output.record", label: "output.record", meta: {}, showDisabledBadge: false }}
        id="n4"
        selected={false}
        type="outputNode"
      />
    );
    expect(html).not.toContain("flow-node-chips");
  });
});
