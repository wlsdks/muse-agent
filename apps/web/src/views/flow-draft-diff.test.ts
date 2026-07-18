import { describe, expect, it } from "vitest";

import { changedDraftFields, describeDraftRevision } from "./flow-draft-diff.js";
import { DICTIONARIES } from "../i18n/strings.js";

import type { FlowDraftPayloadRow } from "../api/types.js";

const BASE: FlowDraftPayloadRow = {
  cronExpression: "0 9 * * *",
  name: "아침 브리핑",
  notifyChannel: null,
  prompt: "오늘 일정을 요약해서 알려줘",
  retry: false,
  action: "agent",
  toolServer: null,
  toolName: null,
  toolArguments: {}
};

function tFor(lang: "en" | "ko") {
  return (key: keyof typeof DICTIONARIES.en) => DICTIONARIES[lang][key];
}

describe("changedDraftFields", () => {
  it("returns an empty list when nothing changed", () => {
    expect(changedDraftFields(BASE, { ...BASE })).toEqual([]);
  });

  it("names exactly the one field that changed (cronExpression only)", () => {
    expect(changedDraftFields(BASE, { ...BASE, cronExpression: "30 8 * * *" })).toEqual(["cronExpression"]);
  });

  it("names every field that changed, in a stable field order, when several change at once", () => {
    const next = { ...BASE, cronExpression: "30 8 * * *", notifyChannel: "telegram:123", retry: true };
    expect(changedDraftFields(BASE, next)).toEqual(["cronExpression", "notifyChannel", "retry"]);
  });

  it("treats null -> a string notifyChannel as changed, and vice versa", () => {
    expect(changedDraftFields(BASE, { ...BASE, notifyChannel: "telegram:1" })).toEqual(["notifyChannel"]);
    expect(changedDraftFields({ ...BASE, notifyChannel: "telegram:1" }, BASE)).toEqual(["notifyChannel"]);
  });
});

describe("describeDraftRevision", () => {
  it("names the changed field + its new value (EN)", () => {
    const t = tFor("en");
    const text = describeDraftRevision(BASE, { ...BASE, cronExpression: "30 8 * * *" }, t);
    expect(text).toContain(t("auto.flows.edit.scheduleLabel"));
    expect(text).toContain("30 8 * * *");
    expect(text.startsWith(t("auto.flows.draft.ackPrefix"))).toBe(true);
  });

  it("names the changed field + its new value (KO)", () => {
    const t = tFor("ko");
    const text = describeDraftRevision(BASE, { ...BASE, cronExpression: "30 8 * * *" }, t);
    expect(text).toContain(t("auto.flows.edit.scheduleLabel"));
    expect(text).toContain("30 8 * * *");
    expect(text.startsWith(t("auto.flows.draft.ackPrefix"))).toBe(true);
  });

  it("lists multiple changed fields, comma-separated", () => {
    const t = tFor("en");
    const next = { ...BASE, notifyChannel: "telegram:123", retry: true };
    const text = describeDraftRevision(BASE, next, t);
    expect(text).toContain(t("auto.flows.edit.notifyLabel"));
    expect(text).toContain(t("auto.flows.edit.retryLabel"));
    expect(text).toContain("telegram:123");
    expect(text).toContain(t("auto.flows.draft.diff.retryOn"));
  });

  it("says notifyChannel cleared to null with the 'none' label, not a blank value", () => {
    const t = tFor("en");
    const prior = { ...BASE, notifyChannel: "telegram:123" };
    const text = describeDraftRevision(prior, BASE, t);
    expect(text).toContain(t("auto.flows.draft.diff.notifyNone"));
  });

  it("says retryOn/retryOff, not a raw boolean", () => {
    const t = tFor("en");
    const on = describeDraftRevision(BASE, { ...BASE, retry: true }, t);
    expect(on).toContain(t("auto.flows.draft.diff.retryOn"));
    const off = describeDraftRevision({ ...BASE, retry: true }, BASE, t);
    expect(off).toContain(t("auto.flows.draft.diff.retryOff"));
  });

  it("falls back to the no-change ack when the revision is a true no-op", () => {
    const t = tFor("en");
    expect(describeDraftRevision(BASE, { ...BASE }, t)).toBe(t("auto.flows.draft.ackNoChange"));
  });

  it("truncates a very long changed prompt so the ack line stays a single line", () => {
    const t = tFor("en");
    const longPrompt = "x".repeat(120);
    const text = describeDraftRevision(BASE, { ...BASE, prompt: longPrompt }, t);
    expect(text.length).toBeLessThan(longPrompt.length);
    expect(text).toContain("…");
  });
});
