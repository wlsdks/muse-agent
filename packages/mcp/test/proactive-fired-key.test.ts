import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runDueProactiveNotices } from "@muse/proactivity";
import { firedKey } from "@muse/proactivity";

describe("firedKey — collision-free dedup key for the {kind,id,startIso} tuple", () => {
  it("two DISTINCT valid tuples get DISTINCT keys", () => {
    const a = firedKey({ id: "a b", kind: "calendar", startIso: "2026-06-15T10:00:00.000Z" });
    const b = firedKey({ id: "a", kind: "calendar", startIso: "2026-06-15T10:00:01.000Z" });
    expect(a).not.toBe(b);
  });

  it("the same tuple still maps to the same key (dedup still works)", () => {
    expect(firedKey({ id: "evt-1", kind: "calendar", startIso: "2026-06-15T10:00:00.000Z" }))
      .toBe(firedKey({ id: "evt-1", kind: "calendar", startIso: "2026-06-15T10:00:00.000Z" }));
  });
});

describe("runDueProactiveNotices — persisted dedupe keys fail closed", () => {
  it("rejects the malformed timestamp needed for a persisted separator-injection collision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-firedkey-"));
    const sidecarFile = join(dir, "proactive-fired.json");
    const startIso = "2026-05-12T15:00:00.000Z";
    // A previously-fired entry crafted to collide under the OLD `${kind} ${id} ${startIso}`:
    //   "calendar a b 2026-05-12T15:00:00.000Z"  (id="a", startIso="b 2026-...Z")
    writeFileSync(sidecarFile, JSON.stringify({
      fired: [{ firedAt: "2026-05-12T14:00:00.000Z", id: "a", kind: "calendar", startIso: `b ${startIso}` }]
    }), "utf8");
    // The NEW imminent event has id "a b" + the clean ISO → SAME old key, distinct tuple.
    const cal = {
      listEvents: async () => [{ allDay: false, endsAt: new Date("2026-05-12T16:00:00Z"), id: "a b", providerId: "local", startsAt: new Date(startIso), title: "Standup" }]
    };
    const sent: string[] = [];
    const messaging = { send: async (_p: string, m: { destination: string; text: string }) => { sent.push(m.text); return { destination: m.destination, messageId: "ok", providerId: "telegram" }; } };
    await expect(runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: messaging as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => new Date("2026-05-12T14:55:00Z"),
      providerId: "telegram",
      sidecarFile
    })).rejects.toThrow(/invalid startIso/iu);
    expect(sent).toHaveLength(0);
  });
});
