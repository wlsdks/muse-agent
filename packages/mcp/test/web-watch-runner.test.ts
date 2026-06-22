import { describe, expect, it } from "vitest";

import { createWebWatchRunner, type ProactiveNoticeSink, type WebWatch } from "@muse/proactivity";

function setup(snapshots: Array<string | undefined>) {
  const delivered: { text: string; title: string; kind: string }[] = [];
  const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
  let i = 0;
  const watch: WebWatch = {
    id: "acme-order",
    message: "Your Acme order shipped",
    rule: { appears: "shipped" },
    snapshot: () => snapshots[Math.min(i++, snapshots.length - 1)],
    title: "Order update"
  };
  const runner = createWebWatchRunner({ sink, watches: [watch] });
  return { delivered, runner };
}

describe("createWebWatchRunner — edge-triggered polling", () => {
  it("delivers exactly one notice on the rising edge, none while the condition steadies", async () => {
    const { delivered, runner } = setup(["Status: processing", "Status: shipped", "Status: shipped (in transit)"]);
    expect((await runner.tick()).delivered).toBe(0); // processing
    expect((await runner.tick()).delivered).toBe(1); // shipped → fire
    expect((await runner.tick()).delivered).toBe(0); // still shipped → no re-fire
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain("Your Acme order shipped");
    expect(delivered[0]!.text).toContain("appeared: shipped");
  });

  it("a failed snapshot is skipped and does NOT lose the baseline (no spurious re-fire after recovery)", async () => {
    // shipped (fire) → snapshot fails (skip) → shipped again (must NOT re-fire — baseline preserved).
    const { delivered, runner } = setup(["Status: shipped", undefined, "Status: shipped"]);
    expect((await runner.tick()).delivered).toBe(1); // first observation, present → fire
    expect((await runner.tick()).delivered).toBe(0); // snapshot failed → skipped
    expect((await runner.tick()).delivered).toBe(0); // shipped again, baseline still "shipped" → no re-fire
    expect(delivered).toHaveLength(1);
  });
});

describe("createWebWatchRunner — delivery-failure resilience", () => {
  function watch(id: string, snap: () => string): WebWatch {
    return { id, message: `${id} shipped`, rule: { appears: "shipped" }, snapshot: snap, title: id };
  }

  it("a transient delivery failure does NOT consume the edge — the notice re-fires next tick", async () => {
    let calls = 0;
    const sink: ProactiveNoticeSink = {
      deliver: () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("messaging down");
        }
      }
    };
    const runner = createWebWatchRunner({ sink, watches: [watch("order", () => "Status: shipped")] });
    expect((await runner.tick()).delivered).toBe(0); // edge fires, deliver THROWS → not counted, baseline not advanced
    expect((await runner.tick()).delivered).toBe(1); // baseline still un-advanced → edge re-fires, deliver succeeds
    expect(calls).toBe(2);
  });

  it("one watch's delivery failure does not abort the other watches' delivery this tick", async () => {
    const okDelivered: string[] = [];
    const sink: ProactiveNoticeSink = {
      deliver: (notice) => {
        if (notice.title === "bad") {
          throw new Error("send failed");
        }
        okDelivered.push(notice.title);
      }
    };
    const runner = createWebWatchRunner({
      sink,
      watches: [watch("bad", () => "Status: shipped"), watch("good", () => "Status: shipped")]
    });
    const summary = await runner.tick();
    expect(summary.delivered).toBe(1); // only "good" counted
    expect(okDelivered).toEqual(["good"]); // "good" delivered despite "bad" throwing first
  });
});
