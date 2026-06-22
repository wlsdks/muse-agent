import { describe, expect, it } from "vitest";

import { deriveAmbientNotices, runAmbientNoticeTick, type AmbientNoticeRule, type ProactiveNoticeSink } from "@muse/proactivity";

const standupRule: AmbientNoticeRule = {
  id: "standup-notes",
  match: { window: "standup" },
  message: "Standup at 14:00 — open your notes.",
  title: "Standup"
};

describe("deriveAmbientNotices", () => {
  it("fires when the rule's field pattern is a substring of the signal", () => {
    const notices = deriveAmbientNotices({ app: "Calendar", window: "Team Standup — 14:00" }, [standupRule]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "ambient", ruleId: "standup-notes", text: "Standup at 14:00 — open your notes." });
  });

  it("requires ALL named match fields to match (not just one)", () => {
    const rule: AmbientNoticeRule = { id: "r", match: { app: "calendar", window: "standup" }, message: "m", title: "t" };
    // app matches, window does NOT → must not fire.
    expect(deriveAmbientNotices({ app: "Calendar", window: "Music" }, [rule])).toEqual([]);
    // both match → fires.
    expect(deriveAmbientNotices({ app: "Calendar", window: "Daily standup" }, [rule])).toHaveLength(1);
  });

  it("a rule with no patterns never fires, and a missing signal field never matches", () => {
    expect(deriveAmbientNotices({ app: "X" }, [{ id: "empty", match: {}, message: "m", title: "t" }])).toEqual([]);
    expect(deriveAmbientNotices({ app: "Calendar" }, [standupRule])).toEqual([]); // no window field
    expect(deriveAmbientNotices(undefined, [standupRule])).toEqual([]);
  });
});

function capturingSink() {
  const delivered: { text: string; title: string; kind: string }[] = [];
  const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
  return { delivered, sink };
}

describe("runAmbientNoticeTick — continuous perception drives a real proactive delivery (no invoke)", () => {
  it("delivers a notice through the sink when the ambient signal matches", async () => {
    const { delivered, sink } = capturingSink();
    const summary = await runAmbientNoticeTick({
      rules: [standupRule],
      sink,
      source: { snapshot: () => ({ app: "Calendar", window: "Team Standup — 14:00" }) }
    });
    expect(summary.delivered).toBe(1);
    expect(summary.firedRuleIds).toContain("standup-notes");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain("Standup at 14:00");
  });

  it("does not re-deliver an already-fired rule (no per-tick spam)", async () => {
    const { delivered, sink } = capturingSink();
    const summary = await runAmbientNoticeTick({
      alreadyFiredRuleIds: ["standup-notes"],
      rules: [standupRule],
      sink,
      source: { snapshot: () => ({ window: "Team Standup" }) }
    });
    expect(summary.delivered).toBe(0);
    expect(delivered).toHaveLength(0);
  });

  it("fail-soft: a throwing signal source delivers nothing", async () => {
    const { delivered, sink } = capturingSink();
    const summary = await runAmbientNoticeTick({
      rules: [standupRule],
      sink,
      source: { snapshot: () => { throw new Error("permission denied reading active window"); } }
    });
    expect(summary.delivered).toBe(0);
    expect(delivered).toHaveLength(0);
  });
});
