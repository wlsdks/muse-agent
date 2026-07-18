/**
 * Pure compile seam for the conversational draft composer's one-line Muse
 * ack ("초안을 갱신했어요 — 일정: 30 8 * * *"): a diff between the draft BEFORE
 * a revision turn and the draft the server returned AFTER it, and the
 * i18n'd text that names only the fields that actually changed. No React,
 * no fetch — mirrors `flow-edit-compile.ts`'s "compile seam" pattern.
 */

import type { FlowDraftPayloadRow } from "../api/types.js";
import type { StringKey, Translate } from "../i18n/index.js";

export type DraftFieldKey = "name" | "cronExpression" | "prompt" | "notifyChannel" | "retry" | "action" | "toolServer" | "toolName" | "toolArguments";

const DRAFT_FIELD_ORDER: readonly DraftFieldKey[] = ["name", "cronExpression", "prompt", "notifyChannel", "retry", "action", "toolServer", "toolName", "toolArguments"];

const DRAFT_FIELD_LABEL_KEY: Record<DraftFieldKey, StringKey> = {
  action: "auto.flows.create.actionKindLabel",
  cronExpression: "auto.flows.edit.scheduleLabel",
  name: "auto.flows.create.nameLabel",
  notifyChannel: "auto.flows.edit.notifyLabel",
  prompt: "auto.flows.edit.promptLabel",
  retry: "auto.flows.edit.retryLabel",
  toolArguments: "auto.flows.edit.toolArgsLabel",
  toolName: "auto.flows.create.toolNameLabel",
  toolServer: "auto.flows.create.toolServerLabel"
};

const VALUE_PREVIEW_MAX_LENGTH = 40;

function previewValue(field: DraftFieldKey, next: FlowDraftPayloadRow, t: Translate): string {
  if (field === "retry") {
    return t(next.retry ? "auto.flows.draft.diff.retryOn" : "auto.flows.draft.diff.retryOff");
  }
  if (field === "notifyChannel") {
    return next.notifyChannel ?? t("auto.flows.draft.diff.notifyNone");
  }
  if (field === "action") {
    return t(next.action === "tool" ? "auto.flows.create.actionKindTool" : "auto.flows.create.actionKindAgent");
  }
  if (field === "toolServer" || field === "toolName") {
    return next[field] ?? "";
  }
  if (field === "toolArguments") {
    const json = JSON.stringify(next.toolArguments);
    return json.length > VALUE_PREVIEW_MAX_LENGTH ? `${json.slice(0, VALUE_PREVIEW_MAX_LENGTH - 1)}…` : json;
  }
  const raw = next[field];
  return raw.length > VALUE_PREVIEW_MAX_LENGTH ? `${raw.slice(0, VALUE_PREVIEW_MAX_LENGTH - 1)}…` : raw;
}

/** Which of the whitelisted draft fields differ between `previous` and `next`. */
export function changedDraftFields(previous: FlowDraftPayloadRow, next: FlowDraftPayloadRow): DraftFieldKey[] {
  return DRAFT_FIELD_ORDER.filter((field) =>
    // toolArguments is the one object field — value-compare it, or two
    // identical arg sets with different identities would read as a change.
    field === "toolArguments"
      ? JSON.stringify(previous.toolArguments) !== JSON.stringify(next.toolArguments)
      : previous[field] !== next[field]
  );
}

/** The one-line ack a revision turn shows in the conversation thread —
 * names only the field(s) that changed, e.g. "Draft updated — Schedule:
 * 30 8 * * *". A revision the model echoed back unchanged says so instead
 * of listing all 5 fields as "changed". */
export function describeDraftRevision(previous: FlowDraftPayloadRow, next: FlowDraftPayloadRow, t: Translate): string {
  const changed = changedDraftFields(previous, next);
  if (changed.length === 0) {
    return t("auto.flows.draft.ackNoChange");
  }
  const parts = changed.map((field) => `${t(DRAFT_FIELD_LABEL_KEY[field])}: ${previewValue(field, next, t)}`);
  return `${t("auto.flows.draft.ackPrefix")}${parts.join(", ")}`;
}
