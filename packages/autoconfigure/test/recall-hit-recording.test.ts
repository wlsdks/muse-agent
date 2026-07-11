import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EpisodicRecallProvider, EpisodicRecallSnapshot } from "@muse/agent-core";
import { readRecallHits } from "@muse/stores";
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

// The hit recording is fire-and-forget inside resolve() (it must not block the
// recall path on disk I/O), so a FIXED sleep races the write under load — the
// source of this test's flakiness in the full parallel `pnpm check`. Poll until
// the expected entries land instead: deterministic (returns the moment the write
// completes), with a generous ceiling so a genuine non-write still fails fast.
async function waitForHits(expected: number): Promise<Awaited<ReturnType<typeof readRecallHits>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const hits = await readRecallHits(file);
    if (hits.length >= expected) return hits;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readRecallHits(file);
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
    const hits = await waitForHits(2);
    expect(hits.map((h) => h.key).sort()).toEqual(["sess-a", "sess-b"]);
    expect(hits.find((h) => h.key === "sess-a")?.summary).toBe("we planned the Q3 budget");
  });

  it("records nothing when recall returns no matches and never throws on a write failure", async () => {
    const wrapped = withRecallHitRecording(fakeProvider({ matches: [] }), file);
    await expect(wrapped.resolve("x", "stark")).resolves.toEqual({ matches: [] });
    await flush();
    expect(await readRecallHits(file)).toEqual([]);
  });

  it("records the query's hash on every hit, so repeated identical queries don't fake diversity (query-diversity gate fuel)", async () => {
    const snapshot: EpisodicRecallSnapshot = {
      matches: [{ narrative: "we planned the Q3 budget", sessionId: "sess-a", similarity: 0.8 }]
    };
    const wrapped = withRecallHitRecording(fakeProvider(snapshot), file);
    await wrapped.resolve("What's the Q3 budget?", "stark");
    await wrapped.resolve("what's the q3 budget?", "stark"); // same query, different case — should hash the SAME
    let hit: Awaited<ReturnType<typeof readRecallHits>>[number] | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      hit = (await readRecallHits(file)).find((h) => h.key === "sess-a");
      if ((hit?.hits ?? 0) >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(hit?.hits).toBe(2);
    expect(hit?.queryHashes).toHaveLength(2);
    expect(hit?.queryHashes?.[0]).toBe(hit?.queryHashes?.[1]);
  });
});
