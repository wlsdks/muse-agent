import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readConsents, recordConsent, type ScopedConsent } from "../src/personal-consent-store.js";

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-consent-concurrent-")); file = join(dir, "consents.json"); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

const consent = (id: string): ScopedConsent => ({
  grantedAt: "2026-06-01T00:00:00Z",
  id,
  objectiveId: "o1",
  scope: "github:issues:write",
  userId: "u"
});

// DS-3: recordConsent moved off the in-process-only mutation queue onto the
// cross-process file lock (personal-tasks-store's mutateTasks pattern), because
// a daemon tick and a manual CLI grant are SEPARATE processes and a lost
// consent record is outbound-safety-relevant (rule 5).
describe("recordConsent — cross-process file lock", () => {
  it("blocks its write while an externally-held (cross-process) lock is present", async () => {
    // Simulate another process already holding the lock: create the lock file
    // directly (bypassing withFileLock) the way a sibling process would.
    const lockPath = `${file}.lock`;
    await writeFile(lockPath, "external-holder", "utf8");

    let resolved = false;
    const pending = recordConsent(file, consent("c1")).then(() => { resolved = true; });

    // If recordConsent still went through withFileLock, it is retrying against
    // the held lock and has not written yet. Without the lock wrapper this
    // assertion goes RED — the write proceeds immediately regardless of the
    // externally-held lock file.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(resolved).toBe(false);
    expect(await readConsents(file)).toHaveLength(0);

    await unlink(lockPath);
    await pending;
    expect(resolved).toBe(true);
    expect(await readConsents(file)).toHaveLength(1);
  }, 10_000);

  it("keeps every concurrently-recorded consent (no lost grant over 50 parallel writers)", { timeout: 60_000 }, async () => {
    await Promise.all(Array.from({ length: 50 }, (_unused, i) => recordConsent(file, consent(`c${i.toString()}`))));
    const all = await readConsents(file);
    expect(all).toHaveLength(50);
    expect(new Set(all.map((c) => c.id)).size).toBe(50);
  }, 30_000);
});
