import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseResidentDaemonRestartStateReceipt } from "@muse/runtime-state";
import { describe, expect, it, vi } from "vitest";

import {
  openResidentDaemonRestartStateJournal,
  ResidentDaemonRestartStateError,
  resolveResidentDaemonRestartStateFile
} from "./resident-daemon-restart-state.js";

const START = new Date("2026-07-25T19:00:00.000Z");

describe("resident daemon restart state journal", () => {
  it("persists owner-only transitions and one half-open generation", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-resident-restart-"));
    let now = START;
    const journal = await openResidentDaemonRestartStateJournal({
      env: { HOME: home },
      now: () => now,
      policy: {
        baseDelayMs: 1_000,
        failureThreshold: 1,
        failureWindowMs: 60_000,
        maxDelayMs: 4_000,
        openCooldownMs: 30_000
      }
    });

    await journal.recordFailure(10);
    expect(await journal.decideAdmission("generation_0001")).toMatchObject({
      delayMs: 30_000,
      state: "open"
    });
    now = new Date(START.getTime() + 30_000);
    expect(await journal.decideAdmission("generation_0001"))
      .toEqual({ state: "half-open-probe" });
    expect(await journal.decideAdmission("generation_0002")).toMatchObject({ state: "open" });
    await journal.recordSuccess("generation_0001");
    expect(await journal.decideAdmission("generation_0003")).toEqual({ state: "admit" });

    const persisted = parseResidentDaemonRestartStateReceipt(await readFile(journal.file, "utf8"));
    expect(persisted).toMatchObject({
      admittedGeneration: "generation_0003",
      failureCount: 0,
      lastFailureSequence: 10,
      state: "closed",
      successfulGeneration: null
    });
    expect(await openResidentDaemonRestartStateJournal({
      env: { HOME: home },
      now: () => now
    })).toBeDefined();
    if (process.platform !== "win32") {
      expect((await stat(journal.file)).mode & 0o777).toBe(0o600);
    }
  });

  it("serializes transitions and poisons the tail after a persistence failure", async () => {
    let writes = 0;
    const writeFile = vi.fn(async () => {
      writes += 1;
      if (writes > 1) throw new Error("PRIVATE disk failure");
    });
    const journal = await openResidentDaemonRestartStateJournal({
      env: { HOME: "/private/test" },
      now: () => START,
      writeFile
    });

    await expect(journal.recordFailure(1)).rejects.toBeInstanceOf(ResidentDaemonRestartStateError);
    await expect(journal.reset()).rejects.toBeInstanceOf(ResidentDaemonRestartStateError);
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it("rejects corrupt, non-owner-only, escaping, and symlinked state without overwrite", async () => {
    expect(() => resolveResidentDaemonRestartStateFile({ HOME: "relative" }))
      .toThrow(ResidentDaemonRestartStateError);
    const home = await mkdtemp(join(tmpdir(), "muse-resident-restart-owner-"));
    const file = resolveResidentDaemonRestartStateFile({ HOME: home });
    await mkdir(join(home, ".muse"), { recursive: true });
    await writeFile(file, "{PRIVATE corrupt", { mode: 0o600 });
    await expect(openResidentDaemonRestartStateJournal({ env: { HOME: home } }))
      .rejects.toBeInstanceOf(ResidentDaemonRestartStateError);
    expect(await readFile(file, "utf8")).toBe("{PRIVATE corrupt");

    if (process.platform === "win32") return;
    await chmod(file, 0o644);
    await expect(openResidentDaemonRestartStateJournal({ env: { HOME: home } }))
      .rejects.toBeInstanceOf(ResidentDaemonRestartStateError);

    const outside = await mkdtemp(join(tmpdir(), "muse-resident-restart-outside-"));
    expect(() => resolveResidentDaemonRestartStateFile({
      HOME: home,
      MUSE_DAEMON_RESTART_STATE_FILE: join(outside, "restart.json")
    })).toThrow(ResidentDaemonRestartStateError);

    const link = join(home, "linked-parent");
    await symlink(outside, link);
    await expect(openResidentDaemonRestartStateJournal({
      env: {
        HOME: home,
        MUSE_DAEMON_RESTART_STATE_FILE: join(link, "restart.json")
      }
    })).rejects.toBeInstanceOf(ResidentDaemonRestartStateError);
  });

  it("rejects group/world-writable owner path components", async () => {
    if (process.platform === "win32") return;
    const unsafeHome = await mkdtemp(join(tmpdir(), "muse-resident-restart-unsafe-home-"));
    await chmod(unsafeHome, 0o777);
    await expect(openResidentDaemonRestartStateJournal({ env: { HOME: unsafeHome } }))
      .rejects.toBeInstanceOf(ResidentDaemonRestartStateError);

    const unsafeMuseHome = await mkdtemp(join(tmpdir(), "muse-resident-restart-unsafe-muse-"));
    const museDir = join(unsafeMuseHome, ".muse");
    await mkdir(museDir, { mode: 0o777 });
    await chmod(museDir, 0o777);
    await expect(openResidentDaemonRestartStateJournal({ env: { HOME: unsafeMuseHome } }))
      .rejects.toBeInstanceOf(ResidentDaemonRestartStateError);
  });

  it("makes owner reset exact and does not replay the consumed failure watermark", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-resident-restart-reset-"));
    const journal = await openResidentDaemonRestartStateJournal({
      env: { HOME: home },
      now: () => START
    });
    await journal.recordFailure(50);
    const reset = await journal.reset();
    expect(reset).toMatchObject({
      failureCount: 0,
      lastFailureSequence: 50,
      state: "closed"
    });
    expect(await journal.recordFailure(50)).toBe(reset);
  });
});
