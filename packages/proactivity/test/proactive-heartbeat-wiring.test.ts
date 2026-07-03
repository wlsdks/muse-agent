import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { readProactiveHeartbeat, writeTasks } from "@muse/stores";
import { runDueProactiveNotices } from "@muse/proactivity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pheartbeat-wire-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const NOW = new Date("2026-05-18T09:00:00.000Z");

describe("runDueProactiveNotices — DS-8 liveness heartbeat", () => {
  it("(a) healthy tick writes BOTH alive and fired, co-located with the sidecar", async () => {
    const sidecarFile = join(dir, "proactive-fired.json");
    const registry = new MessagingProviderRegistry([]);

    const summary = await runDueProactiveNotices({
      destination: "555",
      messagingRegistry: registry,
      now: () => NOW,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary.errors).toEqual([]);

    const hb = await readProactiveHeartbeat(dir);
    expect(hb.alive?.at).toBe(NOW.toISOString());
    expect(hb.fired?.at).toBe(NOW.toISOString());
  });

  it("(b) a tick whose deliveries all fail writes alive but NOT fired", async () => {
    const sidecarFile = join(dir, "proactive-fired.json");
    const tasksFile = join(dir, "tasks.json");
    await writeTasks(tasksFile, [{
      createdAt: "2026-05-18T08:00:00.000Z",
      dueAt: "2026-05-18T09:05:00.000Z",
      id: "t-q3",
      status: "open" as const,
      title: "Send the Q3 budget memo"
    }]);

    // A provider whose send fails permanently (400) → every send fails →
    // summary.errors populated, fast (non-retryable, no backoff ladder).
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async () => new Response(JSON.stringify({ description: "Bad Request", ok: false }), {
        headers: { "content-type": "application/json" },
        status: 400
      }),
      token: "BOT-TOK"
    });
    const registry = new MessagingProviderRegistry([telegram]);

    const summary = await runDueProactiveNotices({
      destination: "555",
      messagingRegistry: registry,
      now: () => NOW,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(summary.imminent).toBe(1);
    expect(summary.fired).toBe(0);
    expect(summary.errors.length).toBeGreaterThan(0);

    const hb = await readProactiveHeartbeat(dir);
    expect(hb.alive?.at).toBe(NOW.toISOString());
    expect(hb.fired).toBeUndefined(); // no clean pass ⇒ fired stays stale/absent
  });

  it("(c) heartbeatDir: null disables the heartbeat entirely", async () => {
    const sidecarFile = join(dir, "proactive-fired.json");
    await runDueProactiveNotices({
      destination: "555",
      heartbeatDir: null,
      messagingRegistry: new MessagingProviderRegistry([]),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile
    });
    expect(await readProactiveHeartbeat(dir)).toEqual({});
  });

  it("an explicit heartbeatDir overrides the sidecar location", async () => {
    const sidecarFile = join(dir, "sub", "proactive-fired.json");
    const hbDir = dir;
    await runDueProactiveNotices({
      destination: "555",
      heartbeatDir: hbDir,
      messagingRegistry: new MessagingProviderRegistry([]),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile
    });
    expect((await readProactiveHeartbeat(hbDir)).alive?.at).toBe(NOW.toISOString());
  });
});
