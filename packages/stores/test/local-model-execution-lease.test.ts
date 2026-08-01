import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FileLocalModelExecutionLeaseCoordinator,
  LocalModelExecutionLeaseError
} from "../src/local-model-execution-lease.js";

function tokens(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}_${(++next).toString().padStart(8, "0")}`;
}

function liveness(alive: ReadonlySet<number>) {
  return (pid: number) => alive.has(pid) ? "alive" as const : "dead" as const;
}

async function root(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "muse-model-lease-")), "lease");
}

function coordinator(
  leaseRoot: string,
  pid: number,
  alive: ReadonlySet<number>,
  prefix: string,
  options: Pick<ConstructorParameters<typeof FileLocalModelExecutionLeaseCoordinator>[0], "now" | "wait"> = {}
) {
  return new FileLocalModelExecutionLeaseCoordinator({
    backgroundWaitMs: 1_000,
    foregroundWaitMs: 1_000,
    pid,
    pollMs: 5,
    processLiveness: liveness(alive),
    root: leaseRoot,
    token: tokens(prefix),
    ...options
  });
}

describe("FileLocalModelExecutionLeaseCoordinator", () => {
  it("publishes one owner-only lease and removes authoritative transient artifacts on release", async () => {
    const leaseRoot = await root();
    const manager = coordinator(leaseRoot, 101, new Set([101]), "single");
    const lease = await manager.acquire("foreground");

    expect(await lease.validate()).toBe(true);
    expect(JSON.parse(readFileSync(join(leaseRoot, "active.json"), "utf8"))).toMatchObject({
      pid: 101,
      role: "foreground",
      sequence: 1,
      version: 1
    });
    if (process.platform !== "win32") {
      expect(lstatSync(leaseRoot).mode & 0o077).toBe(0);
      expect(lstatSync(join(leaseRoot, "active.json")).mode & 0o077).toBe(0);
    }

    await lease.release();
    await lease.release();
    expect(existsSync(join(leaseRoot, "active.json"))).toBe(false);
    expect(readdirSync(join(leaseRoot, "tickets"))).toEqual([]);
    expect(readdirSync(join(leaseRoot, "candidates"))).toEqual([]);
    expect(existsSync(join(leaseRoot, "guard.json"))).toBe(false);
  });

  it("serializes simultaneous instances and never admits the second before settlement", async () => {
    const leaseRoot = await root();
    const alive = new Set([101, 202]);
    const first = await coordinator(leaseRoot, 101, alive, "first").acquire("foreground");
    let secondAdmitted = false;
    const secondPromise = coordinator(leaseRoot, 202, alive, "second").acquire("foreground")
      .then((lease) => {
        secondAdmitted = true;
        return lease;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAdmitted).toBe(false);

    await first.release();
    const second = await secondPromise;
    expect(secondAdmitted).toBe(true);
    expect(await second.validate()).toBe(true);
    await second.release();
  });

  it("uses guard sequences for foreground priority without wall-clock ordering authority", async () => {
    const leaseRoot = await root();
    const alive = new Set([1, 2, 3]);
    const logicalTime = { now: () => 0 };
    const active = await coordinator(leaseRoot, 1, alive, "active", logicalTime).acquire("background");
    const starts: string[] = [];
    const backgroundPromise = coordinator(leaseRoot, 2, alive, "background", logicalTime).acquire("background")
      .then((lease) => { starts.push("background"); return lease; });
    await vi.waitFor(() => expect(readdirSync(join(leaseRoot, "tickets"))).toHaveLength(1));
    const foregroundPromise = coordinator(leaseRoot, 3, alive, "foreground", logicalTime).acquire("foreground")
      .then((lease) => { starts.push("foreground"); return lease; });
    await vi.waitFor(() => expect(readdirSync(join(leaseRoot, "tickets"))).toHaveLength(2));

    expect(starts).toEqual([]);
    await active.release();
    const foreground = await foregroundPromise;
    expect(starts).toEqual(["foreground"]);
    await foreground.release();
    const background = await backgroundPromise;
    expect(starts).toEqual(["foreground", "background"]);
    await background.release();
    expect(readdirSync(join(leaseRoot, "candidates"))).toEqual([]);
    expect(readdirSync(join(leaseRoot, "guards"))).toEqual([]);
    expect(readdirSync(join(leaseRoot, "tickets"))).toEqual([]);
    expect(existsSync(join(leaseRoot, "active.json"))).toBe(false);
  });

  it("reaps a dead active owner but a late non-owner release cannot remove the replacement", async () => {
    const leaseRoot = await root();
    const firstManager = coordinator(leaseRoot, 101, new Set([101]), "old");
    const oldLease = await firstManager.acquire("foreground");
    const replacementManager = coordinator(leaseRoot, 202, new Set([202]), "new");
    const replacement = await replacementManager.acquire("foreground");

    expect(await oldLease.validate()).toBe(false);
    expect(await replacement.validate()).toBe(true);
    await oldLease.release();
    expect(await replacement.validate()).toBe(true);
    await replacement.release();
  });

  it("never steals a live owner and returns a fixed retryable timeout", async () => {
    const leaseRoot = await root();
    const alive = new Set([101, 202]);
    const first = await coordinator(leaseRoot, 101, alive, "first").acquire("foreground");
    let logicalNow = 0;
    const waiting = new FileLocalModelExecutionLeaseCoordinator({
      backgroundWaitMs: 50,
      now: () => logicalNow,
      pid: 202,
      pollMs: 5,
      processLiveness: liveness(alive),
      root: leaseRoot,
      token: tokens("second"),
      wait: async () => { logicalNow = 51; }
    }).acquire("background");
    await expect(waiting).rejects.toMatchObject({
      code: "QUEUE_TIMEOUT",
      message: "local model execution lease queue timed out"
    });
    expect(await first.validate()).toBe(true);
    await first.release();
  });

  it("fails closed on unknown owner liveness and corrupt sequence state", async () => {
    const leaseRoot = await root();
    const first = await coordinator(leaseRoot, 101, new Set([101]), "first").acquire("foreground");
    const unknown = new FileLocalModelExecutionLeaseCoordinator({
      foregroundWaitMs: 50,
      pid: 202,
      pollMs: 5,
      processLiveness: () => "unknown",
      root: leaseRoot,
      token: tokens("unknown")
    });
    await expect(unknown.acquire("foreground")).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    await first.release();

    writeFileSync(join(leaseRoot, "sequence.json"), "{\"version\":1,\"nextSequence\":0}\n", { mode: 0o600 });
    await expect(coordinator(leaseRoot, 303, new Set([303]), "corrupt").acquire("foreground"))
      .rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
  });

  it("reaps dead token-scoped choosing and guard tickets before admitting work", async () => {
    const leaseRoot = await root();
    const initial = await coordinator(leaseRoot, 101, new Set([101]), "initial").acquire("foreground");
    await initial.release();
    writeFileSync(join(leaseRoot, "guards", "choosing-dead_choosing.json"), JSON.stringify({
      createdAtMs: 1,
      pid: 999,
      token: "dead_choosing",
      version: 1
    }), { mode: 0o600 });
    writeFileSync(join(leaseRoot, "guards", "guard-dead_guard.json"), JSON.stringify({
      createdAtMs: 1,
      pid: 999,
      sequence: 1,
      token: "dead_guard",
      version: 1
    }), { mode: 0o600 });

    const recovered = await coordinator(leaseRoot, 202, new Set([202]), "recovered").acquire("foreground");
    expect(await recovered.validate()).toBe(true);
    expect(readdirSync(join(leaseRoot, "guards"))).toEqual([]);
    await recovered.release();
  });

  it("never lets a late contender disturb a live guard incarnation", async () => {
    const leaseRoot = await root();
    const alive = new Set([101, 202]);
    let releaseEntered!: () => void;
    let reportEntered!: () => void;
    const entered = new Promise<void>((resolve) => { reportEntered = resolve; });
    const hold = new Promise<void>((resolve) => { releaseEntered = resolve; });
    let paused = false;
    const firstManager = new FileLocalModelExecutionLeaseCoordinator({
      backgroundWaitMs: 1_000,
      foregroundWaitMs: 1_000,
      onGuardStage: async (stage) => {
        if (stage !== "entered" || paused) return;
        paused = true;
        reportEntered();
        await hold;
      },
      pid: 101,
      pollMs: 5,
      processLiveness: liveness(alive),
      root: leaseRoot,
      token: tokens("paused")
    });
    const firstPromise = firstManager.acquire("foreground");
    await entered;
    const secondPromise = coordinator(leaseRoot, 202, alive, "contender").acquire("foreground");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readdirSync(join(leaseRoot, "tickets"))).toEqual([]);
    expect(readdirSync(join(leaseRoot, "guards")).some((name) => name.startsWith("guard-paused_")))
      .toBe(true);

    releaseEntered();
    const first = await firstPromise;
    expect(await first.validate()).toBe(true);
    await first.release();
    const second = await secondPromise;
    expect(await second.validate()).toBe(true);
    await second.release();
    expect(readdirSync(join(leaseRoot, "guards"))).toEqual([]);
  });

  it("removes an aborted queued ticket under the guard without disturbing the active owner", async () => {
    const leaseRoot = await root();
    const alive = new Set([101, 202]);
    const active = await coordinator(leaseRoot, 101, alive, "active").acquire("foreground");
    const controller = new AbortController();
    const waiting = coordinator(leaseRoot, 202, alive, "waiting").acquire("foreground", controller.signal);
    await vi.waitFor(() => expect(readdirSync(join(leaseRoot, "tickets"))).toHaveLength(1));
    controller.abort("private reason");

    await expect(waiting).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(readdirSync(join(leaseRoot, "tickets"))).toEqual([]);
    expect(await active.validate()).toBe(true);
    await active.release();
  });

  it("fails closed on sequence overflow and group-readable authoritative state", async () => {
    const leaseRoot = await root();
    const initial = await coordinator(leaseRoot, 101, new Set([101]), "initial").acquire("foreground");
    await initial.release();
    writeFileSync(join(leaseRoot, "sequence.json"), JSON.stringify({
      nextSequence: Number.MAX_SAFE_INTEGER,
      version: 1
    }), { mode: 0o600 });
    await expect(coordinator(leaseRoot, 202, new Set([202]), "overflow").acquire("foreground"))
      .rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });

    if (process.platform === "win32") return;
    writeFileSync(join(leaseRoot, "sequence.json"), "{\"version\":1,\"nextSequence\":2}\n", { mode: 0o600 });
    chmodSync(join(leaseRoot, "sequence.json"), 0o640);
    await expect(coordinator(leaseRoot, 303, new Set([303]), "badmode").acquire("foreground"))
      .rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });

    chmodSync(join(leaseRoot, "sequence.json"), 0o600);
    chmodSync(leaseRoot, 0o750);
    await expect(coordinator(leaseRoot, 404, new Set([404]), "badrootmode").acquire("foreground"))
      .rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
  });

  it("maps malformed JSON to the fixed state-unavailable contract", async () => {
    const leaseRoot = await root();
    const initial = await coordinator(leaseRoot, 101, new Set([101]), "initial").acquire("foreground");
    await initial.release();
    writeFileSync(join(leaseRoot, "sequence.json"), "{not-json}\n", { mode: 0o600 });
    await expect(coordinator(leaseRoot, 202, new Set([202]), "malformed").acquire("foreground"))
      .rejects.toMatchObject({
        code: "STATE_UNAVAILABLE",
        message: "local model execution lease state is unavailable"
      });
  });

  it("creates no root or ticket for a pre-aborted request and keeps caller reason private", async () => {
    const leaseRoot = await root();
    const controller = new AbortController();
    controller.abort("private reason");
    const manager = coordinator(leaseRoot, 101, new Set([101]), "aborted");
    const error = await manager.acquire("foreground", controller.signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalModelExecutionLeaseError);
    expect(error).toMatchObject({
      code: "REQUEST_ABORTED",
      message: "local model execution lease request was cancelled"
    });
    expect(JSON.stringify(error)).not.toContain("private reason");
    expect(existsSync(leaseRoot)).toBe(false);
  });

  it("rejects a symlink root without touching its target", async () => {
    if (process.platform === "win32") return;
    const base = await mkdtemp(join(tmpdir(), "muse-model-lease-link-"));
    const target = join(base, "target");
    const leaseRoot = join(base, "lease");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, leaseRoot, "dir");
    await expect(coordinator(leaseRoot, 101, new Set([101]), "link").acquire("foreground"))
      .rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(readdirSync(target)).toEqual([]);
  });
});
