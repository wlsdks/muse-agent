import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  projectUserMemoryAutoExtractHealth,
  readUserMemoryAutoExtractHealth,
  type UserMemoryAutoExtractReason
} from "../src/index.js";

const nowMs = Date.parse("2026-07-27T12:00:00.000Z");

function outcome(reason: UserMemoryAutoExtractReason, minute: number) {
  return { reason, recordedAt: new Date(nowMs - minute * 60_000).toISOString() };
}

describe("projectUserMemoryAutoExtractHealth", () => {
  it("returns fixed counts, recent success, and the active technical-failure streak", () => {
    const projection = projectUserMemoryAutoExtractHealth([
      outcome("learned", 10),
      outcome("nothing_new", 9),
      outcome("policy_rejected", 8),
      outcome("model_error", 7),
      outcome("schema_error", 6),
      outcome("store_error", 5),
      outcome("timeout", 4)
    ], { nowMs });

    expect(projection).toEqual({
      consecutiveFailures: 4,
      freshness: "fresh",
      lastSuccessAt: outcome("learned", 10).recordedAt,
      reasonCounts: {
        learned: 1,
        model_error: 1,
        nothing_new: 1,
        policy_rejected: 1,
        schema_error: 1,
        store_error: 1,
        timeout: 1
      },
      sampleSize: 7,
      status: "degraded"
    });
  });

  it.each(["learned", "nothing_new", "policy_rejected"] as const)("resets technical failures after %s", (resetReason) => {
    const projection = projectUserMemoryAutoExtractHealth([
      outcome("learned", 5),
      outcome("model_error", 4),
      outcome(resetReason, 3)
    ], { nowMs });

    expect(projection.consecutiveFailures).toBe(0);
    expect(projection.status).toBe("healthy");
  });

  it("marks a stale learned success stale rather than healthy", () => {
    const projection = projectUserMemoryAutoExtractHealth([outcome("learned", 24 * 60 + 1)], { nowMs });

    expect(projection).toMatchObject({ freshness: "stale", status: "stale" });
  });

  it("keeps the input bounded to the newest 256 outcomes", () => {
    const projection = projectUserMemoryAutoExtractHealth([
      outcome("learned", 1_000),
      ...Array.from({ length: 300 }, (_, index) => outcome("model_error", 300 - index))
    ], { nowMs, maxInputWindow: 9_999 });

    expect(projection).toMatchObject({
      consecutiveFailures: 256,
      freshness: "no-success",
      reasonCounts: expect.objectContaining({ learned: 0, model_error: 256 }),
      sampleSize: 256,
      status: "degraded"
    });
  });

  it("fails open to no-data for corrupt or unusable sidecars", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-memory-health-"));
    const file = join(directory, "outcomes.json");
    await writeFile(file, "{ definitely not JSON", "utf8");

    await expect(readUserMemoryAutoExtractHealth(file, { nowMs })).resolves.toEqual({
      consecutiveFailures: 0,
      freshness: "no-success",
      reasonCounts: {
        learned: 0,
        model_error: 0,
        nothing_new: 0,
        policy_rejected: 0,
        schema_error: 0,
        store_error: 0,
        timeout: 0
      },
      sampleSize: 0,
      status: "no-data"
    });
  });

  it("fails closed to no-data when a sidecar mixes valid and corrupt outcomes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-memory-health-mixed-"));
    const file = join(directory, "outcomes.json");
    await writeFile(file, JSON.stringify({
      outcomes: [
        {
          reason: "learned",
          recordedAt: new Date(nowMs).toISOString(),
          runIdHash: "a".repeat(32),
          schemaVersion: 1
        },
        {
          reason: "not-a-terminal-reason",
          recordedAt: new Date(nowMs).toISOString(),
          runIdHash: "b".repeat(32),
          schemaVersion: 1
        }
      ]
    }), "utf8");

    await expect(readUserMemoryAutoExtractHealth(file, { nowMs })).resolves.toMatchObject({
      freshness: "no-success",
      sampleSize: 0,
      status: "no-data"
    });
  });
});
