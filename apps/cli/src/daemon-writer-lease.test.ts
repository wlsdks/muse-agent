import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileLocalModelExecutionLeaseCoordinator } from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  acquireResidentWriterLease,
  RESIDENT_WRITER_LEASE_REASON,
  ResidentWriterLeaseError,
  resolveResidentWriterLeaseRoot
} from "./daemon-writer-lease.js";

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "muse-resident-writer-"));
}

describe("resident writer lease", () => {
  it("uses a dedicated owner-local root and rejects unsafe home paths", () => {
    expect(resolveResidentWriterLeaseRoot({ HOME: "/private/owner" }))
      .toBe("/private/owner/.muse/resident-writer-lease");
    expect(() => resolveResidentWriterLeaseRoot({ HOME: "relative" }))
      .toThrowError(expect.objectContaining({
        code: RESIDENT_WRITER_LEASE_REASON.stateUnavailable
      }));
  });

  it("persists process identity with owner-only modes and releases its own authority", async () => {
    const home = await root();
    const lease = await acquireResidentWriterLease({ HOME: home });
    const leaseRoot = resolveResidentWriterLeaseRoot({ HOME: home });
    const activeFile = join(leaseRoot, "active.json");
    const active = JSON.parse(await readFile(activeFile, "utf8")) as Record<string, unknown>;

    expect(active).toMatchObject({
      pid: process.pid,
      role: "background",
      sequence: 1,
      version: 1
    });
    expect(active.token).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/u));
    expect((await stat(leaseRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(activeFile)).mode & 0o777).toBe(0o600);
    expect(await lease.validate()).toBe(true);

    await lease.release();
    expect(existsSync(activeFile)).toBe(false);
  });

  it("admits one concurrent writer and maps the loser to a fixed contended reason", async () => {
    const home = await root();
    const first = await acquireResidentWriterLease({ HOME: home });

    await expect(acquireResidentWriterLease({ HOME: home })).rejects.toEqual(expect.objectContaining({
      code: RESIDENT_WRITER_LEASE_REASON.contended,
      message: RESIDENT_WRITER_LEASE_REASON.contended
    }));
    await first.release();

    const replacement = await acquireResidentWriterLease({ HOME: home });
    expect(await replacement.validate()).toBe(true);
    await replacement.release();
  });

  it("fences a proven dead owner and a late release cannot remove its replacement", async () => {
    const leaseRoot = await root();
    const firstCoordinator = new FileLocalModelExecutionLeaseCoordinator({
      backgroundWaitMs: 0,
      pid: 1101,
      processLiveness: () => "alive",
      root: leaseRoot,
      token: () => "first_owner_token"
    });
    const first = await acquireResidentWriterLease({}, { coordinator: firstCoordinator });
    const secondCoordinator = new FileLocalModelExecutionLeaseCoordinator({
      backgroundWaitMs: 0,
      pid: 2202,
      processLiveness: (pid) => pid === 1101 ? "dead" : "alive",
      root: leaseRoot,
      token: () => "second_owner_token"
    });
    const second = await acquireResidentWriterLease({}, { coordinator: secondCoordinator });

    await first.release();
    expect(await second.validate()).toBe(true);
    expect(JSON.parse(await readFile(join(leaseRoot, "active.json"), "utf8"))).toMatchObject({
      pid: 2202,
      token: "second_owner_token"
    });
    await second.release();
  });

  it("never steals unknown owner state and maps corrupt state without leaking details", async () => {
    const leaseRoot = await root();
    const firstCoordinator = new FileLocalModelExecutionLeaseCoordinator({
      backgroundWaitMs: 0,
      pid: 3303,
      processLiveness: () => "alive",
      root: leaseRoot,
      token: () => "unknown_owner_token"
    });
    const first = await acquireResidentWriterLease({}, { coordinator: firstCoordinator });
    const unknownCoordinator = new FileLocalModelExecutionLeaseCoordinator({
      backgroundWaitMs: 0,
      pid: 4404,
      processLiveness: () => "unknown",
      root: leaseRoot,
      token: () => "unknown_contender_token"
    });

    await expect(acquireResidentWriterLease({}, { coordinator: unknownCoordinator }))
      .rejects.toBeInstanceOf(ResidentWriterLeaseError);
    await expect(acquireResidentWriterLease({}, { coordinator: unknownCoordinator }))
      .rejects.toMatchObject({
        code: RESIDENT_WRITER_LEASE_REASON.stateUnavailable,
        message: RESIDENT_WRITER_LEASE_REASON.stateUnavailable
      });

    await writeFile(join(leaseRoot, "active.json"), "{\"private\":\"do-not-leak\"}\n", { mode: 0o600 });
    await expect(acquireResidentWriterLease({}, {
      coordinator: new FileLocalModelExecutionLeaseCoordinator({
        backgroundWaitMs: 0,
        pid: 5505,
        processLiveness: () => "alive",
        root: leaseRoot,
        token: () => "corrupt_contender_token"
      })
    })).rejects.toMatchObject({
      code: RESIDENT_WRITER_LEASE_REASON.stateUnavailable,
      message: RESIDENT_WRITER_LEASE_REASON.stateUnavailable
    });

    expect(await first.validate()).toBe(false);
  });
});
