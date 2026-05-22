import { describe, expect, it } from "vitest";

import { createWebWatchRunner, type ProactiveNoticeSink, type WebWatch } from "../src/index.js";

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
