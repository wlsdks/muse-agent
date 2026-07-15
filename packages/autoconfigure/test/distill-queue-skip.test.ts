import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { distillQueuedCorrections } from "../src/distill-queue.js";

let dir: string;
let queueFile: string;
let playbookFile: string;

const enqueue = async (events: readonly { id: string; correction: string }[]) => {
  const lines = events.map((event) =>
    JSON.stringify({
      correction: event.correction,
      enqueuedAtMs: 1_700_000_000_000,
      id: event.id,
      priorAnswer: "긴 산문으로 장황하게 답했습니다.",
      request: "월세 얼마야?",
      userId: "stark"
    })
  );
  await writeFile(queueFile, `${lines.join("\n")}\n`, "utf8");
};

const distilled: string[] = [];

const drain = (skipCorrection?: (correction: string) => boolean) =>
  distillQueuedCorrections({
    distill: async (exchange) => {
      distilled.push(exchange.correction);
      return { text: `Lead with the answer (${exchange.correction})`, origin: "distilled" } as never;
    },
    maxPerTick: 10,
    model: "test",
    modelProvider: { generate: async () => ({ output: "" }) as never },
    playbookFile,
    queueFile,
    strategyConsistencySamples: 1,
    ...(skipCorrection ? { skipCorrection } : {})
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-drain-"));
  queueFile = join(dir, "learn-queue.jsonl");
  playbookFile = join(dir, "playbook.json");
  distilled.length = 0;
});

describe("learn-queue drain — the lessons taught where there is no session", () => {
  it("distills a lesson captured on another surface", async () => {
    await enqueue([{ correction: "결론부터 말해줘. 서론 빼고.", id: "e1" }]);
    const recorded = await drain();
    expect(distilled).toEqual(["결론부터 말해줘. 서론 빼고."]);
    expect(recorded).toBeGreaterThan(0);
  });

  it("does NOT relearn a correction the caller is already learning from its own turns", async () => {
    // The capture hook enqueues on every surface, chat included, while the chat's
    // session-end pipeline also scans its own turns. Without this skip the same
    // thing the user said ONCE is distilled twice — and the bank dedup absorbs the
    // second copy by bumping the observation count, so a one-off remark looks like
    // a repeated one and graduates into a standing rule on the strength of a
    // double count. That is the exact failure the community names as the #1 memory
    // bug: a single ambiguous utterance becoming a permanent instruction.
    await enqueue([{ correction: "표로 정리해줘", id: "e1" }]);
    await drain((correction) => correction.trim() === "표로 정리해줘");
    expect(distilled).toEqual([]);
  });

  it("consumes a skipped event so it cannot jam the queue forever", async () => {
    await enqueue([{ correction: "표로 정리해줘", id: "e1" }]);
    await drain(() => true);
    const remaining = await readFile(queueFile, "utf8").catch(() => "");
    const stillPending = remaining
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { id: string; doneAtMs?: number; status?: string });
    // Either removed, or marked consumed — what must NOT happen is that it stays
    // pending and gets re-skipped on every future drain.
    const pending = stillPending.filter((e) => e.doneAtMs === undefined && e.status !== "done");
    expect(pending).toEqual([]);
  });

  it("skips only what the caller names — an unrelated lesson still gets learned", async () => {
    await enqueue([
      { correction: "표로 정리해줘", id: "e1" },
      { correction: "앞으로는 링크도 같이 줘", id: "e2" }
    ]);
    await drain((correction) => correction.trim() === "표로 정리해줘");
    expect(distilled).toEqual(["앞으로는 링크도 같이 줘"]);
  });
});
