import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCheckins, writeCheckins, runDueCheckins, type CheckinSendRegistry, type PersistedCheckin } from "../src/commitment-checkin.js";

function capturingRegistry(sent: { destination: string; text: string }[], options: { readonly failWith?: Error } = {}): CheckinSendRegistry {
  return {
    async send(_providerId: string, message: { readonly destination: string; readonly text: string }): Promise<unknown> {
      if (options.failWith) throw options.failWith;
      sent.push({ destination: message.destination, text: message.text });
      return { ok: true };
    }
  };
}

let dir: string;
let checkinsFile: string;
const lockPath = (): string => `${checkinsFile}.firing.lock`;

function makeCheckin(id: string, dueAtIso: string): PersistedCheckin {
  return {
    commitment: `commitment ${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    dueAtIso,
    id,
    question: `Following up on ${id} — how did it go?`,
    sourceKey: `commitment ${id}`,
    status: "scheduled"
  } as PersistedCheckin;
}

async function seedCheckins(dueAtIso: string, count = 1): Promise<void> {
  const checkins = Array.from({ length: count }, (_, index) => makeCheckin(`chk_${index.toString()}`, dueAtIso));
  await writeCheckins(checkinsFile, checkins);
}

async function lockFileExists(): Promise<boolean> {
  try {
    await stat(lockPath());
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-checkin-lock-"));
  checkinsFile = join(dir, "checkins.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("runDueCheckins — cross-process firing lock (two daemons, same checkins file)", () => {
  it("TWO CONCURRENT daemons racing the same due check-in: delivered EXACTLY once total, one run reports lock-held", async () => {
    await seedCheckins("1970-01-01T00:00:00Z");
    const sent: { destination: string; text: string }[] = [];
    let concurrentSends = 0;
    let maxConcurrentSends = 0;
    const registry: CheckinSendRegistry = {
      async send(_providerId: string, message: { readonly destination: string; readonly text: string }): Promise<unknown> {
        concurrentSends += 1;
        maxConcurrentSends = Math.max(maxConcurrentSends, concurrentSends);
        // Slow provider — widens the race window a real double-send bug needs.
        await new Promise((resolve) => setTimeout(resolve, 40));
        concurrentSends -= 1;
        sent.push({ destination: message.destination, text: message.text });
        return { ok: true };
      }
    };
    const runTick = () => runDueCheckins({ destination: "@me", file: checkinsFile, providerId: "telegram", registry });

    const [a, b] = await Promise.all([runTick(), runTick()]);

    const outcomes = [a.outcome ?? "ran", b.outcome ?? "ran"].sort();
    expect(outcomes).toEqual(["lock-held", "ran"]);
    // Delivered exactly once total across BOTH runs — the double-send this fire closes.
    expect(sent).toHaveLength(1);
    expect(maxConcurrentSends).toBe(1);
    const after = await readCheckins(checkinsFile);
    expect(after.filter((entry) => entry.status === "fired")).toHaveLength(1);
  });

  it("releases the lock after a successful tick — a later tick is not blocked", async () => {
    await seedCheckins("1970-01-01T00:00:00Z");
    const sent: { destination: string; text: string }[] = [];
    const summary = await runDueCheckins({
      destination: "@me",
      file: checkinsFile,
      providerId: "telegram",
      registry: capturingRegistry(sent)
    });
    expect(summary.delivered).toBe(1);
    expect(summary.outcome).toBeUndefined();
    expect(await lockFileExists()).toBe(false);
  });

  it("releases the lock after a provider-failure tick — the next tick can retry rather than being permanently blocked", async () => {
    await seedCheckins("1970-01-01T00:00:00Z");
    const sent: { destination: string; text: string }[] = [];
    const summary = await runDueCheckins({
      destination: "@me",
      file: checkinsFile,
      providerId: "telegram",
      registry: capturingRegistry(sent, { failWith: new Error("upstream 500") })
    });
    expect(summary.delivered).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(await lockFileExists()).toBe(false);

    const retry = await runDueCheckins({
      destination: "@me",
      file: checkinsFile,
      providerId: "telegram",
      registry: capturingRegistry(sent)
    });
    expect(retry.delivered).toBe(1);
  });

  it("a STALE lock left behind by a crashed daemon does not permanently block firing — the tick proceeds", async () => {
    await seedCheckins("1970-01-01T00:00:00Z");
    await writeFile(lockPath(), "crashed-daemon-pid", "utf8");
    const oldMtime = new Date(2026, 6, 1);
    await utimes(lockPath(), oldMtime, oldMtime);

    const sent: { destination: string; text: string }[] = [];
    const summary = await runDueCheckins({
      destination: "@me",
      file: checkinsFile,
      providerId: "telegram",
      registry: capturingRegistry(sent)
    });
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await lockFileExists()).toBe(false);
  });

  it("a LIVE lock (another daemon actively firing) short-circuits to lock-held with no send attempted and no marks", async () => {
    await seedCheckins("1970-01-01T00:00:00Z");
    await writeFile(lockPath(), "other-daemon-pid", "utf8"); // fresh mtime — live

    const sent: { destination: string; text: string }[] = [];
    const summary = await runDueCheckins({
      destination: "@me",
      file: checkinsFile,
      providerId: "telegram",
      registry: capturingRegistry(sent)
    });
    expect(summary.outcome).toBe("lock-held");
    expect(summary.delivered).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(sent).toEqual([]);
    const after = await readCheckins(checkinsFile);
    expect(after.every((entry) => entry.status === "scheduled")).toBe(true); // untouched
  });
});
