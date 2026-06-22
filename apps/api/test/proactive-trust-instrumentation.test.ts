import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { computeTrustScore, readTrustLedger, recordOutcome, writeTasks } from "@muse/stores";
import { runDueProactiveNotices } from "@muse/proactivity";
import { describe, expect, it } from "vitest";

/**
 * Phase 2 (trust instrumentation) wired into the real proactive loop:
 * every delivered notice is recorded, a vetoed source is silenced
 * (learned avoidance), and the daily cap bounds a burst. Real
 * TelegramProvider; only the HTTP boundary is faked.
 */
function fakeOk(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), "muse-proactive-trust-"));
  return {
    sidecarFile: join(dir, "proactive-fired.json"),
    tasksFile: join(dir, "tasks.json"),
    trustLedgerFile: join(dir, "proactive-trust.json")
  };
}

const NOW = new Date("2026-05-18T09:00:00.000Z");
const dueTask = (id: string, title: string) => ({
  createdAt: "2026-05-18T08:00:00.000Z",
  dueAt: "2026-05-18T09:05:00.000Z",
  id,
  status: "open" as const,
  title
});

function provider() {
  const posts: string[] = [];
  const telegram = new TelegramProvider({
    baseUrl: "https://tg.test",
    fetch: async (_url, init) => {
      posts.push(String(init?.body));
      return fakeOk();
    },
    token: "T"
  });
  return { posts, registry: new MessagingProviderRegistry([telegram]) };
}

describe("proactive trust instrumentation — loop wiring", () => {
  it("records every delivered notice to the trust ledger", async () => {
    const fx = fixtures();
    await writeTasks(fx.tasksFile, [dueTask("t-q3", "Send the Q3 memo")]);
    const { posts, registry } = provider();

    const summary = await runDueProactiveNotices({
      destination: "555",
      messagingRegistry: registry,
      now: () => NOW,
      providerId: "telegram",
      ...fx
    });

    expect(summary).toMatchObject({ errors: [], fired: 1 });
    expect(posts).toHaveLength(1);
    const ledger = await readTrustLedger(fx.trustLedgerFile);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: "task", sourceKey: "task:t-q3", title: "Send the Q3 memo" });
    expect(computeTrustScore(ledger).precision).toBe(1);
  });

  it("does NOT surface a source the user vetoed (learned avoidance)", async () => {
    const fx = fixtures();
    await writeTasks(fx.tasksFile, [dueTask("t-q3", "Send the Q3 memo")]);
    await recordOutcome(fx.trustLedgerFile, "task:t-q3", "vetoed", NOW.getTime() - 60_000);
    const { posts, registry } = provider();

    const summary = await runDueProactiveNotices({
      destination: "555",
      messagingRegistry: registry,
      now: () => NOW,
      providerId: "telegram",
      ...fx
    });

    expect(summary.imminent).toBe(1);
    expect(summary.fired).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it("enforces the daily cap across a burst of triggers", async () => {
    const fx = fixtures();
    await writeTasks(fx.tasksFile, [dueTask("t-1", "First"), dueTask("t-2", "Second")]);
    const { posts, registry } = provider();

    const summary = await runDueProactiveNotices({
      dailyCap: 1,
      destination: "555",
      messagingRegistry: registry,
      now: () => NOW,
      providerId: "telegram",
      ...fx
    });

    expect(summary.imminent).toBe(2);
    expect(summary.fired).toBe(1);
    expect(posts).toHaveLength(1);
    expect(await readTrustLedger(fx.trustLedgerFile)).toHaveLength(1);
  });
});
