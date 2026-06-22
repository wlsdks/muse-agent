import { describe, expect, it } from "vitest";

import { createAmbientNoticeRunner, type AmbientNoticeRule, type AmbientSignal, type ProactiveNoticeSink } from "@muse/proactivity";

const standup: AmbientNoticeRule = {
  id: "standup",
  match: { window: "standup" },
  message: "Standup at 14:00 — open your notes.",
  title: "Standup"
};

function setup() {
  let current: AmbientSignal | undefined;
  const delivered: { text: string; title: string; kind: string }[] = [];
  const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
  const runner = createAmbientNoticeRunner({ rules: [standup], sink, source: { snapshot: () => current } });
  return { delivered, runner, set: (signal: AmbientSignal | undefined) => { current = signal; } };
}

describe("createAmbientNoticeRunner — edge-triggered continuous perception", () => {
  it("fires on the rising edge, stays quiet while the condition holds, re-arms after it clears", async () => {
    const { delivered, runner, set } = setup();

    set({ window: "Team Standup — 14:00" });
    expect((await runner.tick()).delivered).toBe(1); // rising edge → fire

    expect((await runner.tick()).delivered).toBe(0); // still matching → no re-fire

    set({ window: "Spotify" });
    expect((await runner.tick()).delivered).toBe(0); // cleared → no fire, re-arms

    set({ window: "Daily Standup" });
    expect((await runner.tick()).delivered).toBe(1); // matches again → fires again

    expect(delivered).toHaveLength(2);
    expect(delivered.every((notice) => notice.text.includes("Standup at 14:00"))).toBe(true);
  });

  it("fail-soft: a throwing source delivers nothing and re-arms cleanly", async () => {
    const delivered: unknown[] = [];
    const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
    const runner = createAmbientNoticeRunner({
      rules: [standup],
      sink,
      source: { snapshot: () => { throw new Error("cannot read active window"); } }
    });
    expect((await runner.tick()).delivered).toBe(0);
    expect(delivered).toHaveLength(0);
  });
});

describe("createAmbientNoticeRunner — delivery-failure resilience", () => {
  it("a transient delivery failure does NOT consume the edge — re-fires next tick", async () => {
    let calls = 0;
    const sink: ProactiveNoticeSink = {
      deliver: () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("messaging down");
        }
      }
    };
    const signal: AmbientSignal = { window: "Daily standup" };
    const runner = createAmbientNoticeRunner({ rules: [standup], sink, source: { snapshot: () => signal } });
    expect((await runner.tick()).delivered).toBe(0); // matched, deliver THREW → not fired, not deduped
    expect((await runner.tick()).delivered).toBe(1); // still matching, not deduped → re-fires, succeeds
    expect(calls).toBe(2);
  });

  it("one rule's delivery failure neither aborts the others nor duplicates them next tick", async () => {
    const rules: AmbientNoticeRule[] = [
      { id: "bad", match: { window: "standup" }, message: "bad", title: "bad" },
      { id: "good", match: { window: "standup" }, message: "good", title: "good" }
    ];
    const got: string[] = [];
    let badCalls = 0;
    const sink: ProactiveNoticeSink = {
      deliver: (notice) => {
        if (notice.title === "bad") {
          badCalls += 1;
          if (badCalls === 1) {
            throw new Error("send failed");
          }
        }
        got.push(notice.title);
      }
    };
    const signal: AmbientSignal = { window: "Daily standup" };
    const runner = createAmbientNoticeRunner({ rules, sink, source: { snapshot: () => signal } });
    expect((await runner.tick()).delivered).toBe(1); // "good" still fires despite "bad" throwing first
    expect(got).toEqual(["good"]);
    // Next tick: "bad" re-fires (not consumed) and succeeds; "good" was
    // delivered → deduped, NOT re-delivered (no duplicate).
    expect((await runner.tick()).delivered).toBe(1);
    expect(got).toEqual(["good", "bad"]);
  });
});
