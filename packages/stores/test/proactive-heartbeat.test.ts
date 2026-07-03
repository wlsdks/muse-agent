import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyProactiveHeartbeat,
  defaultProactiveHeartbeatDir,
  readProactiveHeartbeat,
  recordProactiveHeartbeat,
  type ProactiveHeartbeat
} from "../src/proactive-heartbeat.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "pheartbeat-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const at = (iso: string) => () => new Date(iso);

describe("recordProactiveHeartbeat / readProactiveHeartbeat", () => {
  it("writes and reads back both marks with pid", async () => {
    expect(await recordProactiveHeartbeat(dir, "alive", at("2026-07-01T10:00:00Z"), 111)).toBe(true);
    expect(await recordProactiveHeartbeat(dir, "fired", at("2026-07-01T10:00:01Z"), 111)).toBe(true);
    const hb = await readProactiveHeartbeat(dir);
    expect(hb.alive).toEqual({ at: "2026-07-01T10:00:00.000Z", pid: 111 });
    expect(hb.fired).toEqual({ at: "2026-07-01T10:00:01.000Z", pid: 111 });
  });

  it("read degrades to empty when files are absent (never throws)", async () => {
    expect(await readProactiveHeartbeat(dir)).toEqual({});
  });

  it("a corrupt mark file degrades to undefined, not a throw", async () => {
    await fs.writeFile(join(dir, "proactive-heartbeat-alive.json"), "{ not json", "utf8");
    const hb = await readProactiveHeartbeat(dir);
    expect(hb.alive).toBeUndefined();
  });

  it("record is fail-soft: an unwritable dir returns false, does not throw", async () => {
    // A regular file used AS the heartbeat dir → the internal mkdir/open
    // fails (ENOTDIR) → caught → false, never a throw into the tick loop.
    const blocker = join(dir, "blocker");
    await fs.writeFile(blocker, "i am a file, not a dir", "utf8");
    expect(await recordProactiveHeartbeat(blocker, "alive", at("2026-07-01T10:00:00Z"))).toBe(false);
  });
});

describe("classifyProactiveHeartbeat — alive vs fired recency", () => {
  const nowMs = Date.parse("2026-07-01T10:10:00Z");
  const mark = (iso: string) => ({ at: iso, pid: 1 });

  it("(a) healthy: alive fresh AND fired fresh", () => {
    const hb: ProactiveHeartbeat = { alive: mark("2026-07-01T10:09:30Z"), fired: mark("2026-07-01T10:09:31Z") };
    const v = classifyProactiveHeartbeat(hb, { nowMs });
    expect(v.status).toBe("healthy");
  });

  it("(b) failing: alive fresh but fired stale — running but every tick throws", () => {
    const hb: ProactiveHeartbeat = { alive: mark("2026-07-01T10:09:30Z"), fired: mark("2026-07-01T09:50:00Z") };
    const v = classifyProactiveHeartbeat(hb, { nowMs });
    expect(v.status).toBe("failing");
    expect(v.detail).toMatch(/failing/i);
  });

  it("(b') failing: alive fresh but fired absent — never completed a clean tick", () => {
    const hb: ProactiveHeartbeat = { alive: mark("2026-07-01T10:09:30Z") };
    expect(classifyProactiveHeartbeat(hb, { nowMs }).status).toBe("failing");
  });

  it("(c) dead: alive itself is stale — the ticker isn't running", () => {
    const hb: ProactiveHeartbeat = { alive: mark("2026-07-01T09:00:00Z"), fired: mark("2026-07-01T09:00:00Z") };
    expect(classifyProactiveHeartbeat(hb, { nowMs }).status).toBe("dead");
  });

  it("unknown: no alive mark at all (daemon never ran / older build)", () => {
    expect(classifyProactiveHeartbeat({}, { nowMs }).status).toBe("unknown");
  });

  it("respects custom thresholds", () => {
    const hb: ProactiveHeartbeat = { alive: mark("2026-07-01T10:08:00Z"), fired: mark("2026-07-01T10:08:00Z") };
    // 2 min old; with a 1-min alive threshold it reads as dead
    expect(classifyProactiveHeartbeat(hb, { nowMs, aliveStaleMs: 60_000 }).status).toBe("dead");
  });

  it("reports mark ages", () => {
    const hb: ProactiveHeartbeat = { alive: mark("2026-07-01T10:09:00Z"), fired: mark("2026-07-01T10:09:00Z") };
    const v = classifyProactiveHeartbeat(hb, { nowMs });
    expect(v.aliveAgeMs).toBe(60_000);
    expect(v.firedAgeMs).toBe(60_000);
  });
});

describe("defaultProactiveHeartbeatDir", () => {
  it("defaults to ~/.muse", () => {
    expect(defaultProactiveHeartbeatDir({})).toMatch(/\.muse$/);
  });

  it("co-locates with a relocated sidecar", () => {
    expect(defaultProactiveHeartbeatDir({ MUSE_PROACTIVE_SIDECAR_FILE: "/custom/state/proactive-fired.json" }))
      .toBe("/custom/state");
  });
});
