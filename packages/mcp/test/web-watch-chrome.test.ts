import { describe, expect, it } from "vitest";

import { createChromeSnapshot, createWebWatchRunner, webWatchesFromConfig, type ChromeSnapshotConnection, type ProactiveNoticeSink } from "@muse/proactivity";

// Contract-faithful fake of the Chrome DevTools MCP connection: the
// real chrome-devtools-mcp `take_snapshot` returns the live page's text
// and `navigate_page` points the attached tab at a URL. The fake stands
// at that callTool seam only — the REAL createChromeSnapshot /
// webWatchesFromConfig / runner code paths run.
function fakeChrome(snapshots: string[]): { connection: ChromeSnapshotConnection; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    connection: {
      callTool: async (toolName, args) => {
        calls.push(toolName === "navigate_page" ? `navigate:${String((args as { url?: string }).url)}` : toolName);
        if (toolName === "navigate_page") return "ok";
        if (toolName === "take_snapshot") return snapshots[Math.min(i++, snapshots.length - 1)];
        return `Error: unknown tool ${toolName}`;
      }
    }
  };
}

describe("createChromeSnapshot — read a logged-in page via Chrome DevTools MCP", () => {
  it("navigates to the url THEN snapshots, returning the live page text", async () => {
    const { connection, calls } = fakeChrome(["Order #123: SHIPPED"]);
    const text = await createChromeSnapshot(connection, "https://shop.example/orders/123")();
    expect(text).toBe("Order #123: SHIPPED");
    expect(calls).toEqual(["navigate:https://shop.example/orders/123", "take_snapshot"]);
  });

  it("returns undefined when the connection throws (runner then skips, keeps baseline)", async () => {
    const connection: ChromeSnapshotConnection = { callTool: async () => { throw new Error("chrome detached"); } };
    expect(await createChromeSnapshot(connection, "https://x")()).toBeUndefined();
  });

  it("returns undefined for an empty snapshot", async () => {
    const connection: ChromeSnapshotConnection = { callTool: async (t) => (t === "take_snapshot" ? "   " : "ok") };
    expect(await createChromeSnapshot(connection, "https://x")()).toBeUndefined();
  });
});

describe("webWatchesFromConfig — chrome-source watches", () => {
  const config = JSON.stringify([
    { id: "order", source: "chrome", url: "https://shop.example/orders/123", title: "Order update", message: "Your order changed", rule: { appears: "SHIPPED" } }
  ]);

  it("builds a chrome-backed watch only when a connection is supplied", () => {
    const { connection } = fakeChrome(["pending"]);
    expect(webWatchesFromConfig(config, { chromeConnection: connection })).toHaveLength(1);
    // No connection → the chrome watch is skipped (never silently downgraded to HTTP).
    expect(webWatchesFromConfig(config)).toHaveLength(0);
  });

  it("end-to-end: a chrome watch fires ONE notice on the rising edge, none while steady", async () => {
    // processing → SHIPPED → SHIPPED: the term appears once, then persists.
    const { connection } = fakeChrome(["Order #123: processing", "Order #123: SHIPPED", "Order #123: SHIPPED"]);
    const [watch] = webWatchesFromConfig(config, { chromeConnection: connection });
    const delivered: string[] = [];
    const sink: ProactiveNoticeSink = { deliver: async (n) => { delivered.push(`${n.title}: ${n.text}`); } };
    const runner = createWebWatchRunner({ sink, watches: [watch!] });

    await runner.tick(); // baseline: processing
    await runner.tick(); // edge: SHIPPED appears → fire
    await runner.tick(); // steady: still SHIPPED → no re-fire

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("Order update");
  });
});
