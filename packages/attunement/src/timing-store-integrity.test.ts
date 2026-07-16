import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTimingState, startTimingSession } from "./timing-store.js";

describe("timing-store persistence integrity", () => {
  it("rejects feedback that references a candidate absent from the same state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-timing-store-"));
    const file = join(directory, "timing.json");
    try {
      const session = await startTimingSession(
        file,
        { consentVersion: 1, threadId: "thread-a" },
        async () => undefined,
        { idFactory: () => "session-a", now: () => new Date("2026-07-16T00:00:00.000Z") }
      );
      const malformed = JSON.parse(await readFile(file, "utf8")) as { feedback: unknown[] };
      malformed.feedback.push({
        candidateId: "missing-candidate",
        outcome: "used",
        recordedAt: "2026-07-16T00:01:00.000Z",
        resultingCooldownMs: 1_800_000,
        resultingPolicyVersion: 1,
        sessionId: session.id,
        threadId: session.threadId
      });
      await writeFile(file, JSON.stringify(malformed));

      await expect(readTimingState(file)).rejects.toThrow("timing state has inconsistent relationships");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
