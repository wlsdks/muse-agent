import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileBackedInboxContextProvider, filterFresh } from "./inbox-surface.js";
import { appendInbound } from "./inbox-store.js";
import { readInboxInjectionCursor } from "./inbox-injection-cursor.js";
import type { InboundMessage } from "./types.js";

function msg(overrides: Partial<InboundMessage> & { messageId: string; receivedAtIso: string }): InboundMessage {
  return {
    providerId: "telegram",
    source: "chat-1",
    text: `text-${overrides.messageId}`,
    ...overrides
  };
}

describe("filterFresh", () => {
  it("Bug 1: takes the OLDEST perProviderLimit fresh messages, not the newest", () => {
    // Five fresh messages, cap of 2. With the old `slice(-2)` (newest)
    // the caller would advance the cursor past the three oldest and lose
    // them forever; the correct prefix is the two OLDEST.
    const inbox: InboundMessage[] = [
      msg({ messageId: "m1", receivedAtIso: "2026-01-01T00:00:01Z" }),
      msg({ messageId: "m2", receivedAtIso: "2026-01-01T00:00:02Z" }),
      msg({ messageId: "m3", receivedAtIso: "2026-01-01T00:00:03Z" }),
      msg({ messageId: "m4", receivedAtIso: "2026-01-01T00:00:04Z" }),
      msg({ messageId: "m5", receivedAtIso: "2026-01-01T00:00:05Z" })
    ];
    const fresh = filterFresh(inbox, {}, 2);
    expect(fresh.map((m) => m.messageId)).toEqual(["m1", "m2"]);
  });

  it("Bug 2: a second message sharing the boundary timestamp is fresh once the first is surfaced", () => {
    const inbox: InboundMessage[] = [
      msg({ messageId: "a", receivedAtIso: "2026-01-01T00:00:01Z" }),
      msg({ messageId: "b", receivedAtIso: "2026-01-01T00:00:01Z" })
    ];
    // Cursor at the shared instant, with only "a" recorded as surfaced.
    const cursor = { "chat-1": { ids: ["a"], iso: "2026-01-01T00:00:01Z" } };
    const fresh = filterFresh(inbox, cursor, 20);
    expect(fresh.map((m) => m.messageId)).toEqual(["b"]);

    // Once both ids are recorded at the boundary, neither is fresh.
    const cursorBoth = { "chat-1": { ids: ["a", "b"], iso: "2026-01-01T00:00:01Z" } };
    expect(filterFresh(inbox, cursorBoth, 20)).toHaveLength(0);
  });
});

describe("FileBackedInboxContextProvider — no message loss", () => {
  let dir: string;
  let inboxFile: string;
  let cursorFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-inbox-surface-"));
    inboxFile = join(dir, "inbox.json");
    cursorFile = join(dir, "cursor.json");
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("Bug 1: oldest-beyond-cap messages resurface on the next resolve instead of being lost", async () => {
    for (let i = 1; i <= 4; i++) {
      await appendInbound(inboxFile, msg({ messageId: `m${i.toString()}`, receivedAtIso: `2026-01-01T00:00:0${i.toString()}Z` }));
    }
    const provider = new FileBackedInboxContextProvider({
      perProviderLimit: 2,
      sources: [{ cursorFile, inboxFile, providerId: "telegram" }]
    });

    const first = await provider.resolve();
    expect(first?.messages.map((m) => m.text)).toEqual(["text-m1", "text-m2"]);

    // The two older messages beyond the cap must still be reachable.
    const second = await provider.resolve();
    expect(second?.messages.map((m) => m.text)).toEqual(["text-m3", "text-m4"]);

    const third = await provider.resolve();
    expect(third).toBeUndefined();
  });

  it("Bug 2: two messages with identical receivedAtIso are both eventually surfaced", async () => {
    await appendInbound(inboxFile, msg({ messageId: "a", receivedAtIso: "2026-01-01T00:00:01Z" }));
    await appendInbound(inboxFile, msg({ messageId: "b", receivedAtIso: "2026-01-01T00:00:01Z" }));
    const provider = new FileBackedInboxContextProvider({
      perProviderLimit: 1,
      sources: [{ cursorFile, inboxFile, providerId: "telegram" }]
    });

    const first = await provider.resolve();
    expect(first?.messages).toHaveLength(1);
    const firstId = first?.messages[0]?.text;

    const second = await provider.resolve();
    expect(second?.messages).toHaveLength(1);
    expect(second?.messages[0]?.text).not.toBe(firstId);

    // Both delivered exactly once: nothing left.
    const third = await provider.resolve();
    expect(third).toBeUndefined();

    // Cursor records both surfaced ids at the boundary instant.
    const cursor = await readInboxInjectionCursor(cursorFile);
    expect(cursor["chat-1"]?.iso).toBe("2026-01-01T00:00:01Z");
    expect([...(cursor["chat-1"]?.ids ?? [])].sort()).toEqual(["a", "b"]);
  });
});
