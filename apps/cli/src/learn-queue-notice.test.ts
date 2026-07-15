import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enqueueLearnEvent, recordProactiveHeartbeat, type LearnCorrectionEvent } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { buildLearnQueuePendingNotice } from "./learn-queue-notice.js";

function tmpFile(prefix: string, name: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), name);
}

const ev = (id: string): LearnCorrectionEvent => ({
  correction: "no, bullets not prose", enqueuedAtMs: 1, id, priorAnswer: "prose", userId: "u1"
});

describe("buildLearnQueuePendingNotice", () => {
  it("pending events + a stale/absent daemon → one actionable line naming both commands", async () => {
    const queueFile = tmpFile("muse-lqn-stale-", "learn-queue.jsonl");
    const heartbeatDir = mkdtempSync(join(tmpdir(), "muse-lqn-hb-"));
    await enqueueLearnEvent(queueFile, ev("a"));
    await enqueueLearnEvent(queueFile, ev("b"));

    const notice = await buildLearnQueuePendingNotice(
      { MUSE_LEARN_QUEUE_FILE: queueFile },
      { heartbeatDir }
    );

    expect(notice).toBeDefined();
    expect(notice).toContain("2 corrections queued");
    expect(notice).toContain("muse playbook drain");
    expect(notice).toContain("muse daemon --install");
  });

  it("pending events + a FRESH daemon-loop heartbeat → silent (the daemon will drain it)", async () => {
    const queueFile = tmpFile("muse-lqn-alive-", "learn-queue.jsonl");
    const heartbeatDir = mkdtempSync(join(tmpdir(), "muse-lqn-hb2-"));
    await enqueueLearnEvent(queueFile, ev("a"));
    await recordProactiveHeartbeat(heartbeatDir, "daemon-loop", () => new Date());

    const notice = await buildLearnQueuePendingNotice(
      { MUSE_LEARN_QUEUE_FILE: queueFile },
      { heartbeatDir, now: () => new Date() }
    );

    expect(notice).toBeUndefined();
  });

  it("an empty queue → silent, no heartbeat read needed", async () => {
    const queueFile = tmpFile("muse-lqn-empty-", "learn-queue.jsonl");
    const heartbeatDir = mkdtempSync(join(tmpdir(), "muse-lqn-hb3-"));

    const notice = await buildLearnQueuePendingNotice(
      { MUSE_LEARN_QUEUE_FILE: queueFile },
      { heartbeatDir }
    );

    expect(notice).toBeUndefined();
  });

  it("an unreadable/corrupt queue file fails soft — never throws, treated as empty", async () => {
    const heartbeatDir = mkdtempSync(join(tmpdir(), "muse-lqn-hb4-"));
    await expect(buildLearnQueuePendingNotice(
      { MUSE_LEARN_QUEUE_FILE: "/nonexistent/path/does-not-exist/learn-queue.jsonl" },
      { heartbeatDir }
    )).resolves.toBeUndefined();
  });

  it("singular phrasing for exactly one queued correction", async () => {
    const queueFile = tmpFile("muse-lqn-singular-", "learn-queue.jsonl");
    const heartbeatDir = mkdtempSync(join(tmpdir(), "muse-lqn-hb5-"));
    await enqueueLearnEvent(queueFile, ev("a"));

    const notice = await buildLearnQueuePendingNotice(
      { MUSE_LEARN_QUEUE_FILE: queueFile },
      { heartbeatDir }
    );

    expect(notice).toContain("1 correction queued");
    expect(notice).not.toContain("1 corrections");
  });
});
