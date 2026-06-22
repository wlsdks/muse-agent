import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  firedKey,
  readProactiveFired,
  readSessionLock,
  writeProactiveFired,
  writeSessionLock,
  type ProactiveFiredEntry
} from "../src/proactive-notice-store.js";

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "muse-proactive-store-")), name);
}

describe("session lock (writeSessionLock / readSessionLock)", () => {
  it("returns the until ISO while the lock is active, undefined once it expires", async () => {
    const file = tmpFile("lock.json");
    const until = new Date("2026-06-14T18:00:00Z").toISOString();
    await writeSessionLock(file, { until, setAt: new Date("2026-06-14T12:00:00Z").toISOString() });
    expect(await readSessionLock(file, new Date("2026-06-14T15:00:00Z"))).toBe(until); // before until
    expect(await readSessionLock(file, new Date("2026-06-14T18:00:01Z"))).toBeUndefined(); // past until
  });

  it("returns undefined for a missing lock file (fail-soft)", async () => {
    expect(await readSessionLock(tmpFile("absent.json"), new Date())).toBeUndefined();
  });
});

describe("fired ledger (writeProactiveFired / readProactiveFired)", () => {
  const entry: ProactiveFiredEntry = {
    kind: "calendar",
    id: "evt-1",
    startIso: "2026-06-14T18:00:00Z",
    firedAt: "2026-06-14T17:30:00Z"
  };

  it("round-trips fired entries through the file", async () => {
    const file = tmpFile("fired.json");
    await writeProactiveFired(file, [entry]);
    expect(await readProactiveFired(file)).toEqual([entry]);
  });

  it("returns [] for a missing or malformed file (fail-soft)", async () => {
    expect(await readProactiveFired(tmpFile("absent.json"))).toEqual([]);
  });
});

describe("firedKey", () => {
  it("encodes the {kind,id,startIso} tuple unambiguously (no space-join collision)", () => {
    const a = firedKey({ kind: "task", id: "a b", startIso: "2026-06-14T18:00:00Z" });
    const b = firedKey({ kind: "task", id: "a", startIso: "b 2026-06-14T18:00:00Z" });
    expect(a).not.toBe(b); // a naive `${kind} ${id} ${startIso}` would collide these
  });
});
