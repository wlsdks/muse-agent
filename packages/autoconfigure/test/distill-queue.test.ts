import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CorrectionExchange, DistilledStrategy } from "@muse/agent-core";
import { enqueueLearnEvent, readPlaybook, recordPlaybookStrategy } from "@muse/mcp";
import type { ModelProvider } from "@muse/model";
import { afterEach, describe, expect, it } from "vitest";

import { distillQueuedCorrections } from "../src/distill-queue.js";

let files: string[] = [];
const freshFile = (label: string) => {
  const file = join(tmpdir(), `muse-${label}-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => {
  await Promise.all(files.map((f) => rm(f, { force: true })));
  files = [];
});

// `distill` is injected, so the model is never called — generate must not run.
const modelProvider: Pick<ModelProvider, "generate"> = {
  generate: async () => { throw new Error("model should not be called — distill is injected"); }
};
const distillReturning = (text: string) =>
  async (_exchange: CorrectionExchange): Promise<DistilledStrategy | undefined> => ({ text });

const seedCorrection = (queueFile: string, correction: string) =>
  enqueueLearnEvent(queueFile, { correction, enqueuedAtMs: 1, id: `ev_${randomUUID()}`, priorAnswer: "old answer", userId: "u1" });

describe("distillQueuedCorrections — bank dedup consolidates a repeated correction (sign-safe)", () => {
  it("a re-derived near-duplicate bumps the existing entry's timesObserved instead of writing a 2nd entry, and does NOT graduate it", async () => {
    const queueFile = freshFile("learnq");
    const playbookFile = freshFile("playbook");
    // The bank already holds this lesson, on probation, from an earlier distill.
    await recordPlaybookStrategy(playbookFile, {
      createdAt: "2026-01-01T00:00:00Z", id: "existing", probation: true, reward: -1,
      text: "when rescheduling, default to the next business day", userId: "u1"
    });
    await seedCorrection(queueFile, "you keep rescheduling onto weekends — use a business day");

    const recorded = await distillQueuedCorrections({
      distill: distillReturning("when rescheduling, default to the next business day"),
      model: "m", modelProvider, playbookFile, queueFile
    });

    expect(recorded).toBe(0); // consolidated — nothing newly recorded
    const bank = await readPlaybook(playbookFile);
    expect(bank).toHaveLength(1); // no paraphrase duplicate
    expect(bank[0]?.timesObserved).toBe(2); // raised again → observed twice
    expect(bank[0]?.probation).toBe(true); // STILL on probation — a repeat never graduates
    expect(bank[0]?.reward).toBe(-1); // reward untouched — no positive signal manufactured
  });

  it("a genuinely-distinct lesson IS recorded as a new probation entry (dedup doesn't swallow real new learning)", async () => {
    const queueFile = freshFile("learnq");
    const playbookFile = freshFile("playbook");
    await recordPlaybookStrategy(playbookFile, {
      createdAt: "2026-01-01T00:00:00Z", id: "existing", probation: true,
      text: "when rescheduling, default to the next business day", userId: "u1"
    });
    await seedCorrection(queueFile, "always CC the project lead on status updates");

    const recorded = await distillQueuedCorrections({
      distill: distillReturning("CC the project lead on every status email"),
      model: "m", modelProvider, playbookFile, queueFile
    });

    expect(recorded).toBe(1);
    const bank = await readPlaybook(playbookFile);
    expect(bank).toHaveLength(2); // the distinct lesson was added
    expect(bank.some((e) => e.text.includes("CC the project lead"))).toBe(true);
  });
});
