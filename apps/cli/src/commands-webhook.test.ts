import { describe, expect, it } from "vitest";

import { buildWebhookNotify, resolveWebhookDueAt } from "./commands-webhook.js";

const FIXED_NOW = (): Date => new Date("2026-05-18T09:00:00Z");

describe("resolveWebhookDueAt — a present-but-unparseable dueAt is surfaced, not dropped", () => {
  it("returns the parsed dueAt for an understood hint", () => {
    expect(resolveWebhookDueAt("next monday", FIXED_NOW)).toEqual({ dueAt: "2026-05-25T00:00:00.000Z" });
  });

  it("flags a typo'd hint as unparsed instead of silently yielding no due date", () => {
    expect(resolveWebhookDueAt("next freday", FIXED_NOW)).toEqual({ unparsed: "next freday" });
  });

  it("returns {} for an absent / empty hint (no due date, no warning)", () => {
    expect(resolveWebhookDueAt(undefined, FIXED_NOW)).toEqual({});
    expect(resolveWebhookDueAt("", FIXED_NOW)).toEqual({});
    expect(resolveWebhookDueAt("   ", FIXED_NOW)).toEqual({});
  });
});

describe("buildWebhookNotify — normalise a notify payload (title/notice/task fields)", () => {
  it("builds the notice from a JSON payload and parses a valid dueAt", () => {
    const r = buildWebhookNotify({ title: "Q3 memo", text: "ship it", dueAt: "next monday" }, FIXED_NOW);
    expect(r).toMatchObject({
      ok: true, title: "Q3 memo", notice: "📥 Q3 memo: ship it", dueAt: "2026-05-25T00:00:00.000Z"
    });
    expect((r as { dueAtUnparsed?: string }).dueAtUnparsed).toBeUndefined();
  });

  it("surfaces a typo'd dueAt as dueAtUnparsed and sets NO dueAt", () => {
    const r = buildWebhookNotify({ title: "memo", text: "do it", dueAt: "next freday" }, FIXED_NOW);
    expect(r).toMatchObject({ ok: true, dueAtUnparsed: "next freday" });
    expect((r as { dueAt?: string }).dueAt).toBeUndefined();
  });

  it("defaults the title to 'Webhook' and accepts a plain `body` field", () => {
    expect(buildWebhookNotify({ body: "just a string" }, FIXED_NOW)).toMatchObject({
      ok: true, title: "Webhook", text: "just a string", notice: "📥 Webhook: just a string"
    });
  });

  it("returns ok:false for an empty / whitespace-only text", () => {
    expect(buildWebhookNotify({ title: "x", text: "   " }, FIXED_NOW)).toEqual({ ok: false });
    expect(buildWebhookNotify({}, FIXED_NOW)).toEqual({ ok: false });
  });

  it("truncates an oversized title (200) and text (1024), and elides the notice preview at 240", () => {
    const r = buildWebhookNotify({ title: "T".repeat(500), text: "B".repeat(5000) }, FIXED_NOW);
    if (!r.ok) throw new Error("expected ok");
    expect(r.title.length).toBe(200);
    expect(r.text.length).toBe(1024);
    expect(r.notice.endsWith("…")).toBe(true);
  });
});
