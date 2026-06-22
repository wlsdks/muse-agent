import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rankPlaybookStrategies } from "@muse/agent-core";
import { recordPlaybookStrategy } from "@muse/stores";
import { afterEach, describe, expect, it } from "vitest";

import { buildPlaybookProvider } from "../src/context-engineering-builders.js";
import type { MuseEnvironment } from "../src/index.js";

let files: string[] = [];
const freshFile = (): string => {
  const f = join(tmpdir(), `muse-pb-origin-${randomUUID()}.json`);
  files.push(f);
  return f;
};
afterEach(async () => {
  await Promise.all(files.map((f) => rm(f, { force: true })));
  files = [];
});

describe("buildPlaybookProvider — origin survives the projection (reflected tie-break stays live)", () => {
  it("a reflected strategy keeps its origin and LOSES to an otherwise-equal grounded one when ranked", async () => {
    const file = freshFile();
    // identical text + reward, differing only by provenance — the tie-break's job.
    await recordPlaybookStrategy(file, { createdAt: "2026-01-01T00:00:00Z", id: "r", origin: "reflected", reward: 2, tag: "email", text: "email reply tip", userId: "u1" });
    await recordPlaybookStrategy(file, { createdAt: "2026-01-01T00:00:00Z", id: "g", origin: "grounded", reward: 2, tag: "email", text: "email reply tip", userId: "u1" });

    const provider = buildPlaybookProvider({ MUSE_PLAYBOOK: "true", MUSE_PLAYBOOK_FILE: file } as unknown as MuseEnvironment);
    const strategies = await provider!.listStrategies("u1");

    // the fix: origin survives the projection (was dropped ⇒ reflected penalty + CBR gate inert).
    expect(strategies.some((s) => s.origin === "reflected")).toBe(true);

    // OUTCOME: ranked through the real ranker, evidence beats synthesis — grounded
    // survives the identical-text dedup BECAUSE its origin is preserved.
    const out = rankPlaybookStrategies(strategies, "email reply tip");
    expect(out[0]?.origin).toBe("grounded");
  });
});
