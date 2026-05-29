import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EpisodicRecallProvider, EpisodicRecallSnapshot } from "@muse/agent-core";
import { readRecallHits } from "@muse/mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withRecallHitRecording } from "../src/context-engineering-builders.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-recall-rec-"));
  file = join(dir, "recall-hits.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

function fakeProvider(snapshot: EpisodicRecallSnapshot | undefined): EpisodicRecallProvider {
  return { resolve: async () => snapshot };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("withRecallHitRecording", () => {
  it("records a hit (with narrative) per surfaced session and passes the snapshot through unchanged", async () => {
    const snapshot: EpisodicRecallSnapshot = {
      matches: [
        { narrative: "we planned the Q3 budget", sessionId: "sess-a", similarity: 0.8 },
        { narrative: "you booked the Tokyo trip", sessionId: "sess-b", similarity: 0.6 }
      ]
    };
    const wrapped = withRecallHitRecording(fakeProvider(snapshot), file);
    const out = await wrapped.resolve("budget?", "stark");
    expect(out).toBe(snapshot); // passthrough
    await flush();
    const hits = await readRecallHits(file);
    expect(hits.map((h) => h.key).sort()).toEqual(["sess-a", "sess-b"]);
    expect(hits.find((h) => h.key === "sess-a")?.summary).toBe("we planned the Q3 budget");
  });

  it("records nothing when recall returns no matches and never throws on a write failure", async () => {
    const wrapped = withRecallHitRecording(fakeProvider({ matches: [] }), file);
    await expect(wrapped.resolve("x", "stark")).resolves.toEqual({ matches: [] });
    await flush();
    expect(await readRecallHits(file)).toEqual([]);
  });
});
