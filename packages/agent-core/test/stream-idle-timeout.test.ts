import { ModelProviderError } from "@muse/model";
import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";


import { withStreamIdleTimeout } from "../src/model-loop.js";

async function* prompt(): AsyncIterable<number> { yield 1; yield 2; yield 3; }
async function* stalls(): AsyncIterable<number> { yield 1; await sleep(10_000); yield 2; }

describe("withStreamIdleTimeout — a hung stream fails instead of blocking forever", () => {
  it("passes a promptly-emitting stream through unchanged", async () => {
    const out: number[] = [];
    for await (const v of withStreamIdleTimeout(prompt(), 1_000, "ollama")) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  it("throws a ModelProviderError when the provider STALLS past the idle window (after yielding what it had)", async () => {
    const out: number[] = [];
    await expect((async () => {
      for await (const v of withStreamIdleTimeout(stalls(), 50, "ollama")) out.push(v);
    })()).rejects.toThrowError(ModelProviderError);
    expect(out).toEqual([1]); // got the first event, then the stall tripped
  });

  it("the idle error is NON-retryable (a hung stream fails the turn, not a transient retry)", async () => {
    try {
      for await (const _v of withStreamIdleTimeout(stalls(), 30, "ollama")) { /* drain */ }
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ModelProviderError);
      expect((e as ModelProviderError).retryable).toBe(false);
    }
  });

  it("idleMs<=0 disables the timeout (passthrough)", async () => {
    const out: number[] = [];
    for await (const v of withStreamIdleTimeout(prompt(), 0, "ollama")) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  it("the timer RESETS per event — a slow-but-progressing stream is never cut", async () => {
    async function* slowProgress(): AsyncIterable<number> {
      for (const v of [1, 2, 3]) { await sleep(30); yield v; } // 30ms gaps < 50ms idle
    }
    const out: number[] = [];
    for await (const v of withStreamIdleTimeout(slowProgress(), 50, "ollama")) out.push(v);
    expect(out).toEqual([1, 2, 3]); // never tripped despite total > 50ms
  });
});
