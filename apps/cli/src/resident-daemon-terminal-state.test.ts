import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseResidentDaemonTerminalStateReceipt } from "@muse/runtime-state";
import { describe, expect, it, vi } from "vitest";

import {
  openResidentDaemonTerminalStateJournal,
  ResidentDaemonTerminalStateError,
  resolveResidentDaemonTerminalStateFile
} from "./resident-daemon-terminal-state.js";

describe("resident daemon terminal state journal", () => {
  it("persists owner-only state and serializes stable/failure transitions", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-resident-terminal-"));
    const times = [
      new Date("2026-07-22T03:00:00.000Z"),
      new Date("2026-07-22T03:01:00.000Z"),
      new Date("2026-07-22T03:02:00.000Z")
    ];
    const ids = ["failure_01"];
    const journal = await openResidentDaemonTerminalStateJournal({
      env: { HOME: home },
      generation: "resident_generation_01",
      idFactory: () => ids.shift()!,
      now: () => times.shift()!,
      pid: 4321
    });

    const stable = journal.markStable("heartbeat-established");
    const failed = journal.recordFailure(
      Object.assign(new Error("Bearer PRIVATE"), { status: 401 }),
      { domain: "provider" }
    );
    const [stableReceipt, failedReceipt] = await Promise.all([stable, failed]);

    expect(stableReceipt.sequence + 1).toBe(failedReceipt.sequence);
    expect(failedReceipt.failures.at(-1)).toMatchObject({
      reasonCode: "provider-auth-failed"
    });
    const persisted = parseResidentDaemonTerminalStateReceipt(
      await readFile(journal.file, "utf8")
    );
    expect(persisted).toEqual(failedReceipt);
    expect(JSON.stringify(persisted)).not.toMatch(/Bearer|PRIVATE/iu);
    if (process.platform !== "win32") {
      expect((await stat(journal.file)).mode & 0o777).toBe(0o600);
    }
  });

  it("turns corrupt prior JSON into bounded store-corruption evidence", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-resident-terminal-corrupt-"));
    const file = resolveResidentDaemonTerminalStateFile({ HOME: home });
    await mkdir(join(home, ".muse"), { recursive: true });
    await writeFile(file, "{PRIVATE corrupt", { mode: 0o600 });

    const journal = await openResidentDaemonTerminalStateJournal({
      env: { HOME: home },
      generation: "resident_generation_02",
      idFactory: () => "failure_corrupt_01",
      now: () => new Date("2026-07-22T03:00:00.000Z"),
      pid: 9876
    });

    expect(journal.current()).toMatchObject({
      failures: [expect.objectContaining({ reasonCode: "store-corrupt" })],
      status: "failed"
    });
    expect(JSON.stringify(journal.current())).not.toContain("PRIVATE");
  });

  it("refuses unsafe paths and non-owner-only existing state without overwriting", async () => {
    expect(() => resolveResidentDaemonTerminalStateFile({ HOME: "relative" }))
      .toThrow(ResidentDaemonTerminalStateError);
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "muse-resident-terminal-mode-"));
    const file = resolveResidentDaemonTerminalStateFile({ HOME: home });
    await mkdir(join(home, ".muse"), { recursive: true });
    await writeFile(file, "{}", { mode: 0o600 });
    await chmod(file, 0o644);
    const before = await readFile(file, "utf8");

    await expect(openResidentDaemonTerminalStateJournal({
      env: { HOME: home },
      generation: "resident_generation_01",
      pid: 4321
    })).rejects.toBeInstanceOf(ResidentDaemonTerminalStateError);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("poisons later transitions after a persistence failure", async () => {
    let writes = 0;
    const writeFile = vi.fn(async () => {
      writes += 1;
      if (writes > 1) throw new Error("PRIVATE disk failure");
    });
    const journal = await openResidentDaemonTerminalStateJournal({
      env: { HOME: "/private/test" },
      generation: "resident_generation_01",
      now: () => new Date("2026-07-22T03:00:00.000Z"),
      pid: 4321,
      writeFile
    });

    await expect(journal.markStable("heartbeat-established"))
      .rejects.toBeInstanceOf(ResidentDaemonTerminalStateError);
    await expect(journal.recordFailure(new Error("later")))
      .rejects.toBeInstanceOf(ResidentDaemonTerminalStateError);
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it("does not let a queued stable transition resurrect a failed generation", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-resident-terminal-race-"));
    const journal = await openResidentDaemonTerminalStateJournal({
      env: { HOME: home },
      generation: "resident_generation_01",
      idFactory: () => "failure_race_01",
      now: () => new Date("2026-07-22T03:00:00.000Z"),
      pid: 4321
    });

    const failed = journal.recordFailure(new Error("PRIVATE"));
    const resurrect = journal.markStable("tick-completed");
    await expect(failed).resolves.toMatchObject({ status: "failed" });
    await expect(resurrect).rejects.toThrow("failure is final");
    expect(parseResidentDaemonTerminalStateReceipt(await readFile(journal.file, "utf8")))
      .toMatchObject({ status: "failed" });
  });

  it("rejects overrides outside owner home and symlinked parent directories", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-resident-terminal-owner-"));
    const outside = await mkdtemp(join(tmpdir(), "muse-resident-terminal-outside-"));
    expect(() => resolveResidentDaemonTerminalStateFile({
      HOME: home,
      MUSE_DAEMON_TERMINAL_STATE_FILE: join(outside, "terminal.json")
    })).toThrow(ResidentDaemonTerminalStateError);

    if (process.platform === "win32") return;
    const link = join(home, "linked-parent");
    await symlink(outside, link);
    await expect(openResidentDaemonTerminalStateJournal({
      env: {
        HOME: home,
        MUSE_DAEMON_TERMINAL_STATE_FILE: join(link, "terminal.json")
      },
      generation: "resident_generation_01",
      pid: 4321
    })).rejects.toBeInstanceOf(ResidentDaemonTerminalStateError);
  });
});
