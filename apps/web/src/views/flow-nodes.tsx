import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { safeDateTime } from "../lib/datetime.js";

import type { FlowCanvasNodeData } from "./flow-canvas-mapping.js";
import type { FlowNodeKind } from "../api/types.js";
import type { StringKey } from "../i18n/index.js";
import type { ReactNode } from "react";

// `nodeTypes`'s registration requires each component to accept the LIBRARY's
// general `Node` shape (it can't know our narrowed `FlowCanvasNodeType`
// union up front) — so components are typed against the untyped-`type`
// `Node<FlowCanvasNodeData>`, not the narrower `FlowCanvasNode` the mapper
// produces for tests.
type FlowNodeProps = NodeProps<Node<FlowCanvasNodeData>>;

export const KIND_LABEL_KEY: Record<FlowNodeKind, StringKey> = {
  "action.agent": "auto.flows.kind.actionAgent",
  "action.tool": "auto.flows.kind.actionTool",
  "output.notify": "auto.flows.kind.outputNotify",
  "output.record": "auto.flows.kind.outputRecord",
  "output.webhook": "auto.flows.kind.outputWebhook",
  "trigger.schedule": "auto.flows.kind.triggerSchedule"
};

export const META_LABEL_KEY: Record<string, StringKey> = {
  channelId: "auto.flows.meta.channelId",
  cronExpression: "auto.flows.meta.cronExpression",
  maxToolCalls: "auto.flows.meta.maxToolCalls",
  model: "auto.flows.meta.model",
  nextRunAtIso: "auto.flows.meta.nextRunAtIso",
  prompt: "auto.flows.meta.prompt",
  server: "auto.flows.meta.server",
  timezone: "auto.flows.meta.timezone",
  tool: "auto.flows.meta.tool",
  url: "auto.flows.meta.url"
};

const KIND_ICON: Record<FlowNodeKind, (p: { className?: string }) => ReactNode> = {
  "action.agent": Icon.chat,
  "action.tool": Icon.tool,
  "output.notify": Icon.bell,
  "output.record": Icon.note,
  "output.webhook": Icon.plug,
  "trigger.schedule": Icon.clock
};

export function formatMetaValue(key: string, value: string | number | boolean | null, locale: string): string | null {
  if (value === null || value === "") {
    return null;
  }
  if (key === "nextRunAtIso" && typeof value === "string") {
    return safeDateTime(value, locale) || value;
  }
  return String(value);
}

/** The shared visual shell every flow-canvas node type renders through —
 * icon + kind eyebrow + label + meta chips, matching the console's card
 * language (dark surface, hairline border, pill chips). */
function FlowNodeShell({
  categoryKey,
  kind,
  data,
  selected
}: {
  categoryKey: StringKey;
  kind: FlowNodeKind;
  data: FlowCanvasNodeData;
  selected?: boolean;
}) {
  const { locale, t } = useI18n();
  const NodeIcon = KIND_ICON[kind];
  const chips = Object.entries(data.meta)
    .map(([key, value]) => ({ key, value: formatMetaValue(key, value, locale) }))
    .filter((entry): entry is { key: string; value: string } => entry.value !== null);

  return (
    <div
      className={`flow-node${selected ? " selected" : ""}`}
      style={{ opacity: data.flowEnabled ? 1 : 0.55 }}
    >
      <Handle type="target" position={Position.Left} style={{ visibility: "hidden" }} />
      <div className="flow-node-head">
        <span className="flow-node-ic" aria-hidden="true">
          <NodeIcon />
        </span>
        <div>
          <div className="flow-node-eyebrow">{t(categoryKey)}</div>
          <div className="flow-node-title">{t(KIND_LABEL_KEY[kind])}</div>
        </div>
        {data.showDisabledBadge && <span className="flow-node-badge">{t("auto.flows.disabledBadge")}</span>}
      </div>
      {chips.length > 0 && (
        <div className="flow-node-chips">
          {chips.map((chip) => (
            <span className="flow-node-chip" key={chip.key}>
              {t(META_LABEL_KEY[chip.key] ?? "auto.flows.meta.prompt")}: {chip.value}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ visibility: "hidden" }} />
    </div>
  );
}

export function TriggerNode({ data, selected }: FlowNodeProps) {
  return <FlowNodeShell categoryKey="auto.flows.category.trigger" kind={data.kind} data={data} selected={selected} />;
}

export function ActionNode({ data, selected }: FlowNodeProps) {
  return <FlowNodeShell categoryKey="auto.flows.category.action" kind={data.kind} data={data} selected={selected} />;
}

export function OutputNode({ data, selected }: FlowNodeProps) {
  return <FlowNodeShell categoryKey="auto.flows.category.output" kind={data.kind} data={data} selected={selected} />;
}

export const FLOW_NODE_TYPES = {
  actionNode: ActionNode,
  outputNode: OutputNode,
  triggerNode: TriggerNode
};
