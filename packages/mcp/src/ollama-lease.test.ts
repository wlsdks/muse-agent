import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireOllamaLease,
  isOllamaLeaseHeldByOther,
  releaseOllamaLease,
  resolveOllamaLeaseFile
} from "@muse/stores";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-lease-"));
  file = join(dir, "ollama.lease");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const alive = (): boolean => true;
const dead = (): boolean => false;

describe("resolveOllamaLeaseFile", () => {
  it("honors MUSE_OLLAMA_LEASE_FILE, else ~/.muse/ollama.lease", () => {
    expect(resolveOllamaLeaseFile({ MUSE_OLLAMA_LEASE_FILE: "/tmp/x.lease" })).toBe("/tmp/x.lease");
    expect(resolveOllamaLeaseFile({})).toMatch(/[\\/]\.muse[\\/]ollama\.lease$/u);
  });
});

describe("isOllamaLeaseHeldByOther — contention guard, fail-safe", () => {
  it("false when no lease exists (never block foreground work)", () => {
    expect(isOllamaLeaseHeldByOther(file, 999, { nowMs: 1000, isAlive: alive })).toBe(false);
  });

  it("true when a DIFFERENT live process holds a fresh lease", async () => {
    await acquireOllamaLease(file, 4242, 1000);
    expect(isOllamaLeaseHeldByOther(file, 999, { nowMs: 1500, isAlive: alive })).toBe(true);
  });

  it("false when the lease is OUR OWN pid (the daemon never blocks on itself)", async () => {
    await acquireOllamaLease(file, 999, 1000);
    expect(isOllamaLeaseHeldByOther(file, 999, { nowMs: 1500, isAlive: alive })).toBe(false);
  });

  it("false when the holder pid is dead (auto-released)", async () => {
    await acquireOllamaLease(file, 4242, 1000);
    expect(isOllamaLeaseHeldByOther(file, 999, { nowMs: 1500, isAlive: dead })).toBe(false);
  });

  it("false when the heartbeat is stale (auto-released)", async () => {
    await acquireOllamaLease(file, 4242, 1000);
    expect(isOllamaLeaseHeldByOther(file, 999, { nowMs: 1000 + 10 * 60_000, staleMs: 2 * 60_000, isAlive: alive })).toBe(false);
  });
});

describe("releaseOllamaLease — only the owner clears it", () => {
  it("clears our own lease but leaves someone else's", async () => {
    await acquireOllamaLease(file, 4242, 1000);
    await releaseOllamaLease(file, 111); // not the owner → left alone
    expect(isOllamaLeaseHeldByOther(file, 999, { nowMs: 1500, isAlive: alive })).toBe(true);
    await releaseOllamaLease(file, 4242); // owner → cleared
    expect(isOllamaLeaseHeldByOther(file, 999, { nowMs: 1500, isAlive: alive })).toBe(false);
  });
});
