import { describe, expect, it } from "vitest";

import { createWebWatchRunner, webWatchesFromConfig, type ProactiveNoticeSink } from "@muse/proactivity";

function sequenceFetch(bodies: Array<{ status: number; body: string }>) {
  let i = 0;
  const fetchImpl = (async () => {
    const r = bodies[Math.min(i++, bodies.length - 1)]!;
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof globalThis.fetch;
  return fetchImpl;
}

const noWait = { baseDelayMs: 0, sleep: async () => {} };

describe("webWatchesFromConfig — parse + build runnable HTTP watches", () => {
  it("builds a watch whose snapshot HTTP-fetches the url", async () => {
    const watches = webWatchesFromConfig(
      JSON.stringify([{ id: "w1", message: "Order shipped", rule: { appears: "shipped" }, title: "Order", url: "https://x.test/order" }]),
      { fetchImpl: sequenceFetch([{ body: "Status: shipped", status: 200 }]) }
    );
    expect(watches).toHaveLength(1);
    expect(await watches[0]!.snapshot()).toBe("Status: shipped");
  });

  it("drops invalid entries (no url / no rule condition / missing fields) and non-array / malformed JSON", () => {
    const watches = webWatchesFromConfig(JSON.stringify([
      { id: "ok", message: "m", rule: { appears: "x" }, title: "t", url: "https://x.test" },
      { id: "no-url", message: "m", rule: { appears: "x" }, title: "t" },
      { id: "no-rule", message: "m", rule: {}, title: "t", url: "https://x.test" },
      { id: "", message: "m", rule: { appears: "x" }, title: "t", url: "https://x.test" }
    ]));
    expect(watches.map((w) => w.id)).toEqual(["ok"]);
    expect(webWatchesFromConfig("{not json")).toEqual([]);
    expect(webWatchesFromConfig(JSON.stringify({ not: "array" }))).toEqual([]);
  });

  it("drops a duplicate watch id so runners keep one baseline per watch", () => {
    const watches = webWatchesFromConfig(JSON.stringify([
      { id: "same", message: "one", rule: { appears: "x" }, title: "one", url: "https://x.test/one" },
      { id: "same", message: "two", rule: { appears: "x" }, title: "two", url: "https://x.test/two" }
    ]));
    expect(watches.map((watch) => watch.title)).toEqual(["one"]);
  });

  it("snapshot returns undefined on a permanent HTTP failure (runner then skips)", async () => {
    const [watch] = webWatchesFromConfig(
      JSON.stringify([{ id: "w", message: "m", rule: { appears: "x" }, title: "t", url: "https://x.test" }]),
      { fetchImpl: sequenceFetch([{ body: "", status: 404 }]), retryOptions: noWait }
    );
    expect(await watch!.snapshot()).toBeUndefined();
  });

  it("end-to-end: a config-built watch fires once when the HTTP page transitions to the watched term", async () => {
    const watches = webWatchesFromConfig(
      JSON.stringify([{ id: "w", message: "Your order shipped", rule: { appears: "shipped" }, title: "Order", url: "https://x.test/order" }]),
      { fetchImpl: sequenceFetch([{ body: "processing", status: 200 }, { body: "shipped now", status: 200 }, { body: "shipped now", status: 200 }]), retryOptions: noWait }
    );
    const delivered: { text: string; title: string; kind: string }[] = [];
    const sink: ProactiveNoticeSink = { deliver: (n) => { delivered.push(n); } };
    const runner = createWebWatchRunner({ sink, watches });
    expect((await runner.tick()).delivered).toBe(0); // processing
    expect((await runner.tick()).delivered).toBe(1); // shipped → fire
    expect((await runner.tick()).delivered).toBe(0); // still shipped → no re-fire
    expect(delivered[0]!.text).toContain("Your order shipped");
  });
});
