import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MacOsCalendarProvider } from "../src/macos-provider.js";
import type { CalendarRange } from "../src/types.js";

// Direct coverage for the macOS Calendar.app provider (untested module). It
// spawns `osascript`; the pure parse/quote/iso helpers aren't exported, so the
// real runScript path is exercised through a CONTRACT-FAITHFUL fake osascript
// binary (a tiny shell script the provider really spawns) that emits the
// documented tab-separated output / exit code / stderr. This proves the spawn
// LIFECYCLE the agent depends on: output parsing, error classification
// (permission / not-found / generic exit), the wall-clock timeout that stops a
// wedged AppleScript or an unanswered TCC prompt from hanging forever, and a
// spawn failure.

const dir = mkdtempSync(join(tmpdir(), "muse-macos-"));
let seq = 0;
// win32 can't spawn a shebang shell script — and the macOS provider never runs there.
const fakeOsascript = (sh: string): string => {
  const path = join(dir, `fake-${(seq++).toString()}.sh`);
  writeFileSync(path, `#!/bin/sh\n${sh}\n`);
  chmodSync(path, 0o755);
  return path;
};
const RANGE: CalendarRange = { from: new Date("2026-05-30T00:00:00Z"), to: new Date("2026-05-31T00:00:00Z") };
const provider = (osascriptPath: string, timeoutMs?: number) =>
  new MacOsCalendarProvider({ osascriptPath, ...(timeoutMs ? { timeoutMs } : {}) });

describe.skipIf(process.platform === "win32")("MacOsCalendarProvider — listEvents output parsing", () => {
  it("parses the tab-separated lines into events (allDay from the 6th field, optional location)", async () => {
    // Z-suffixed ISO keeps the date assertions timezone-independent.
    const bin = fakeOsascript(
      "cat >/dev/null\n" +
      "printf 'uid1\\t2026-05-30T09:00:00Z\\t2026-05-30T09:30:00Z\\tStandup\\tRoom A\\tfalse\\n" +
      "uid2\\t2026-12-25T00:00:00Z\\t2026-12-26T00:00:00Z\\tHoliday\\t\\ttrue\\n'"
    );
    const events = await provider(bin).listEvents(RANGE);
    expect(events).toEqual([
      { allDay: false, endsAt: new Date("2026-05-30T09:30:00Z"), id: "uid1", location: "Room A", providerId: "macos", startsAt: new Date("2026-05-30T09:00:00Z"), title: "Standup" },
      { allDay: true, endsAt: new Date("2026-12-26T00:00:00Z"), id: "uid2", providerId: "macos", startsAt: new Date("2026-12-25T00:00:00Z"), title: "Holiday" }
    ]);
  });

  it("skips malformed lines (too few fields or an unparseable date)", async () => {
    const bin = fakeOsascript(
      "cat >/dev/null\n" +
      "printf 'good\\t2026-05-30T09:00:00Z\\t2026-05-30T10:00:00Z\\tOK\\t\\tfalse\\n" +
      "incomplete\\tonly\\ttwo\\n" +
      "baddate\\tnot-a-date\\t2026-05-30T10:00:00Z\\tNope\\t\\tfalse\\n'"
    );
    const events = await provider(bin).listEvents(RANGE);
    expect(events.map((e) => e.id)).toEqual(["good"]); // the two malformed lines dropped
  });
});

describe.skipIf(process.platform === "win32")("MacOsCalendarProvider — error classification", () => {
  it("maps a permission-denied stderr to EVENT_PERMISSION", async () => {
    const bin = fakeOsascript('cat >/dev/null\necho "Calendar is not allowed to access your calendars" >&2\nexit 1');
    await expect(provider(bin).listEvents(RANGE)).rejects.toMatchObject({ code: "EVENT_PERMISSION" });
  });

  it("maps an EVENT_NOT_FOUND error to EVENT_NOT_FOUND (delete of an absent id)", async () => {
    const bin = fakeOsascript('cat >/dev/null\necho "EVENT_NOT_FOUND" >&2\nexit 1');
    await expect(provider(bin).deleteEvent("missing")).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("maps any other non-zero exit to EXIT_<code> with the stderr tail", async () => {
    const bin = fakeOsascript('cat >/dev/null\necho "syntax error" >&2\nexit 2');
    await expect(provider(bin).listEvents(RANGE)).rejects.toMatchObject({ code: "EXIT_2" });
  });

  it("kills a wedged script at the timeout and rejects OSASCRIPT_TIMEOUT", async () => {
    const bin = fakeOsascript("cat >/dev/null\nsleep 5\necho done");
    const started = Date.now();
    await expect(provider(bin, 150).listEvents(RANGE)).rejects.toMatchObject({ code: "OSASCRIPT_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2_000); // killed promptly, not after sleep 5
  });

  it("rejects OSASCRIPT_FAILED when the binary cannot be spawned", async () => {
    await expect(provider(join(dir, "does-not-exist")).listEvents(RANGE)).rejects.toMatchObject({ code: "OSASCRIPT_FAILED" });
  });
});

describe.skipIf(process.platform === "win32")("MacOsCalendarProvider — writes", () => {
  it("createEvent returns the uid printed by the script + the input fields", async () => {
    const bin = fakeOsascript("cat >/dev/null\nprintf 'new-uid-123'");
    const created = await provider(bin).createEvent({ endsAt: new Date("2026-06-01T11:00:00Z"), location: "Z", startsAt: new Date("2026-06-01T10:00:00Z"), title: "New" });
    expect(created).toMatchObject({ id: "new-uid-123", location: "Z", providerId: "macos", title: "New" });
  });

  it("updateEvent with no fields throws EMPTY_UPDATE before spawning", async () => {
    const bin = fakeOsascript("cat >/dev/null\nprintf ''"); // would succeed if spawned
    await expect(provider(bin).updateEvent("e1", {})).rejects.toMatchObject({ code: "EMPTY_UPDATE" });
  });
});
