import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { beginSessionWithCrashCheck, endSessionClean, sessionMarkerPath } from "../src/session-recovery.js";

function tmpMarker(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-ses-")), "session.marker");
}

const info = { pid: 99, startedAt: "2026-06-24T10:00:00.000Z" };

describe("session-recovery lifecycle", () => {
  it("first ever boot reports no prior crash and records the start", async () => {
    const path = tmpMarker();
    expect(await beginSessionWithCrashCheck(path, info)).toBeUndefined();
  });

  it("a boot following an UNCLEAN exit reports the prior session's info", async () => {
    const path = tmpMarker();
    await beginSessionWithCrashCheck(path, info); // session A starts, never cleanly ends (crash)
    const prior = await beginSessionWithCrashCheck(path, { pid: 100, startedAt: "2026-06-24T11:00:00.000Z" });
    expect(prior).toEqual(info); // session B sees A's surviving marker
  });

  it("a boot following a CLEAN exit reports no prior crash", async () => {
    const path = tmpMarker();
    await beginSessionWithCrashCheck(path, info);
    await endSessionClean(path);
    expect(await beginSessionWithCrashCheck(path, { pid: 101, startedAt: "2026-06-24T12:00:00.000Z" })).toBeUndefined();
  });

  it("sessionMarkerPath points under ~/.muse", () => {
    expect(sessionMarkerPath()).toMatch(/\.muse[/\\]session\.marker$/u);
  });
});
