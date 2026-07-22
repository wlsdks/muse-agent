import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { createWebWatchRunner, webWatchesFromConfig } from "../src/web-watch.js";

function config(source?: "chrome"): string {
  return JSON.stringify(Array.from({ length: source ? 1 : 4 }, (_, index) => ({
    id: source ? "chrome" : `http-${index.toString()}`,
    message: source ? "chrome" : `http-${index.toString()}`,
    rule: { appears: "ready" },
    ...(source ? { source } : {}),
    title: source ? "chrome" : `http-${index.toString()}`,
    url: `https://example.test/${index.toString()}`
  })));
}

describe("web-watch snapshot concurrency", () => {
  it("overlaps exactly two config-created HTTP snapshots", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = (async () => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(5);
        active -= 1;
        return new Response("ready");
      }) as typeof globalThis.fetch;
    const watches = webWatchesFromConfig(config(), { fetchImpl });
    const runner = createWebWatchRunner({ sink: { deliver: async () => undefined }, watches });

    await runner.tick();

    expect(peak).toBe(2);
  });

  it("flushes pending HTTP reads before a serial Chrome-like snapshot and preserves delivery order", async () => {
    let activeHttp = 0;
    const delivered: string[] = [];
    const fetchImpl = (async () => {
      activeHttp += 1;
      await delay(5);
      activeHttp -= 1;
      return new Response("ready");
    }) as typeof globalThis.fetch;
    const chromeConnection = {
      callTool: async (name: string) => {
        if (name === "navigate_page") return undefined;
        expect(activeHttp).toBe(0);
        return "ready";
      }
    };
    const watches = [
      ...webWatchesFromConfig(JSON.stringify(JSON.parse(config()).slice(0, 2)), { fetchImpl }),
      ...webWatchesFromConfig(config("chrome"), { chromeConnection })
    ];
    const runner = createWebWatchRunner({
      sink: { deliver: async (notice) => { delivered.push(notice.text); } },
      watches
    });

    await runner.tick(); // establish baselines
    await runner.tick(); // unchanged, still no delivery
    expect(delivered).toEqual([
      "http-0 (appeared: ready)",
      "http-1 (appeared: ready)",
      "chrome (appeared: ready)"
    ]);
  });
});
