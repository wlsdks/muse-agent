import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { fetchWithVoiceTimeout } from "../src/http-utils.js";

describe("fetchWithVoiceTimeout", () => {
  it("falls back to the normal timeout for a fractional value instead of truncating it to an immediate abort", async () => {
    let signal: AbortSignal | null | undefined;
    await fetchWithVoiceTimeout(
      async (_url, init) => {
        signal = init.signal;
        return new Response("ok");
      },
      "https://voice.example.test",
      {},
      0.5
    );

    await sleep(10);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});
