import { describe, expect, it } from "vitest";

import { createWebWatchRunner, detectWatchTrigger, webWatchesFromConfig, type ProactiveNoticeSink, type WebWatch } from "@muse/proactivity";

describe("detectWatchTrigger — extract narrows the snapshot to a region before matching", () => {
  it("onAnyChange fires only when the EXTRACTED region changes, ignoring page noise", () => {
    const rule = { extract: "Status: (\\w+)", onAnyChange: true };
    // The status is steady (processing); only the noisy timestamp changed.
    const quiet = detectWatchTrigger(
      "Updated 10:00 — Status: processing — ad#41",
      "Updated 10:05 — Status: processing — ad#92",
      rule
    );
    expect(quiet.triggered).toBe(false);
    // Now the status itself changed.
    const fired = detectWatchTrigger(
      "Updated 10:05 — Status: processing — ad#92",
      "Updated 10:09 — Status: shipped — ad#13",
      rule
    );
    expect(fired.triggered).toBe(true);
  });

  it("appears matches within the extracted region, not the whole noisy page", () => {
    const rule = { appears: "shipped", extract: "Status: (\\w+)" };
    // 'shipped' is present on the page (in an ad) but NOT in the status region → no fire.
    const noise = detectWatchTrigger("Status: processing", "Status: processing — get free shipped delivery", rule);
    expect(noise.triggered).toBe(false);
    // 'shipped' enters the status region → fire.
    const real = detectWatchTrigger("Status: processing", "Status: shipped now", rule);
    expect(real.triggered).toBe(true);
  });

  it("an invalid regex fails open to the whole text (capability degrades, never crashes)", () => {
    const rule = { appears: "shipped", extract: "Status: (\\w+" }; // unbalanced paren
    const t = detectWatchTrigger("processing", "now shipped", rule);
    expect(t.triggered).toBe(true);
  });
});

describe("webWatchesFromConfig — parses the extract field into the rule", () => {
  it("a config watch with extract narrows to the region end-to-end through the runner", async () => {
    let i = 0;
    const bodies = [
      "<div>banner 10:00</div> Price: $42 <footer>id 9a1</footer>",
      "<div>banner 10:05</div> Price: $42 <footer>id 7c2</footer>", // only noise changed
      "<div>banner 10:09</div> Price: $39 <footer>id 4d3</footer>"  // price changed
    ];
    const fetchImpl = (async () => new Response(bodies[Math.min(i++, bodies.length - 1)]!, { status: 200 })) as unknown as typeof globalThis.fetch;

    const watches = webWatchesFromConfig(
      JSON.stringify([{ id: "price", message: "Price changed", rule: { extract: "Price: (\\$\\d+)", onAnyChange: true }, title: "Price", url: "https://shop.test/item" }]),
      { fetchImpl, retryOptions: { baseDelayMs: 0, sleep: async () => {} } }
    );
    expect(watches).toHaveLength(1);

    const delivered: { title: string; text: string }[] = [];
    const sink: ProactiveNoticeSink = { deliver: (n) => { delivered.push(n); } };
    const runner = createWebWatchRunner({ sink, watches: watches as WebWatch[] });

    expect((await runner.tick()).delivered).toBe(0); // baseline
    expect((await runner.tick()).delivered).toBe(0); // only noise changed → no fire
    expect((await runner.tick()).delivered).toBe(1); // price changed → fire
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain("Price changed");
  });
});
