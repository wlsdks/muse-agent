import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileBackedInboxContextProvider, filterFresh } from "../src/inbox-surface.js";
import { readInboxInjectionCursor } from "../src/inbox-injection-cursor.js";
import type { InboundMessage } from "../src/types.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "muse-inbox-surface-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function writeInbox(file: string, messages: readonly InboundMessage[]): Promise<void> {
  await writeFile(file, JSON.stringify({ inbox: messages, version: 1 }, null, 2), "utf8");
}

const sampleMessages: readonly InboundMessage[] = [
  {
    messageId: "1",
    providerId: "slack",
    receivedAtIso: "2026-05-11T08:00:00.000Z",
    source: "C1",
    text: "hello"
  },
  {
    messageId: "2",
    providerId: "slack",
    receivedAtIso: "2026-05-11T08:05:00.000Z",
    source: "C1",
    text: "world"
  },
  {
    messageId: "3",
    providerId: "slack",
    receivedAtIso: "2026-05-11T08:10:00.000Z",
    source: "C2",
    text: "another channel"
  }
];

describe("filterFresh", () => {
  it("filters out messages older than the cursor per source", () => {
    const fresh = filterFresh(sampleMessages, { C1: { ids: [], iso: "2026-05-11T08:00:00.000Z" } }, 10);
    expect(fresh.map((m) => m.messageId)).toEqual(["2", "3"]);
  });

  it("caps to perProviderLimit (OLDEST first, so the cursor advances over a contiguous prefix)", () => {
    // The cap keeps the OLDEST perProviderLimit fresh messages: the
    // caller advances the cursor to the newest it surfaces, so keeping a
    // contiguous oldest prefix leaves the unshipped tail strictly newer
    // than the cursor (it resurfaces next turn). Keeping the NEWEST N
    // would jump the cursor past — and silently lose — the older ones.
    const fresh = filterFresh(sampleMessages, {}, 2);
    expect(fresh.map((m) => m.messageId)).toEqual(["1", "2"]);
  });

  it("ties on parsed instant resolve by messageId asc, independent of file-array insertion order", () => {
    const sameInstant = "2026-05-11T08:00:00.000Z";
    const insertedOutOfOrder: readonly InboundMessage[] = [
      { messageId: "b", providerId: "slack", receivedAtIso: sameInstant, source: "C1", text: "B" },
      { messageId: "a", providerId: "slack", receivedAtIso: sameInstant, source: "C1", text: "A" },
      { messageId: "c", providerId: "slack", receivedAtIso: sameInstant, source: "C1", text: "C" }
    ];
    const fresh = filterFresh(insertedOutOfOrder, {}, 10);
    expect(
      fresh.map((m) => m.messageId),
      "messages sharing the parsed instant must come back in messageId asc order — independent of file-array insertion order"
    ).toEqual(["a", "b", "c"]);
  });

  it("freshness is by parsed instant, not lexicographic ISO (cross-provider precision/offset)", () => {
    // Cursor written by a second-precision provider; a genuinely
    // 0.5s-newer message from a millis-precision provider. The
    // string "…00.500Z" sorts BEFORE "…00Z" ('.' < 'Z'), so a
    // lexicographic `>` would WRONGLY drop this real new message.
    const msgs: readonly InboundMessage[] = [
      { messageId: "newer", providerId: "telegram", receivedAtIso: "2026-05-11T08:00:00.500Z", source: "C1", text: "hi" },
      { messageId: "older", providerId: "slack", receivedAtIso: "2026-05-11T07:00:00.000Z", source: "C1", text: "old" }
    ];
    const fresh = filterFresh(msgs, { C1: { ids: [], iso: "2026-05-11T08:00:00Z" } }, 10);
    expect(fresh.map((m) => m.messageId)).toEqual(["newer"]); // not silently dropped

    // Cross-provider offset ordering: -05:00 day is "…05-10…" but its
    // instant is the newest. Sort is by parsed instant ascending, and
    // the cap keeps the two OLDEST in instant order.
    const ordered: readonly InboundMessage[] = [
      { messageId: "a", providerId: "slack", receivedAtIso: "2026-05-11T00:00:00.000Z", source: "X", text: "" },
      { messageId: "b", providerId: "slack", receivedAtIso: "2026-05-11T00:00:01.000Z", source: "X", text: "" },
      { messageId: "c", providerId: "discord", receivedAtIso: "2026-05-10T20:00:02-05:00", source: "X", text: "" }
    ];
    expect(filterFresh(ordered, {}, 2).map((m) => m.messageId)).toEqual(["a", "b"]);
  });
});

describe("FileBackedInboxContextProvider", () => {
  it("returns recent messages and advances the cursor", async () => {
    const inboxFile = join(workdir, "slack-inbox.json");
    const cursorFile = join(workdir, "slack-cursor.json");
    await writeInbox(inboxFile, sampleMessages);

    const provider = new FileBackedInboxContextProvider({
      sources: [{ cursorFile, inboxFile, providerId: "slack" }]
    });
    const first = await provider.resolve();
    expect(first?.messages.length).toBe(3);

    // Second call: cursor has advanced — should now return nothing
    const second = await provider.resolve();
    expect(second).toBeUndefined();

    const cursor = await readInboxInjectionCursor(cursorFile);
    expect(cursor.C1?.iso).toBe("2026-05-11T08:05:00.000Z");
    expect(cursor.C2?.iso).toBe("2026-05-11T08:10:00.000Z");
  });

  it("returns undefined when no messages exist", async () => {
    const inboxFile = join(workdir, "slack-inbox.json");
    const cursorFile = join(workdir, "slack-cursor.json");
    await writeInbox(inboxFile, []);

    const provider = new FileBackedInboxContextProvider({
      sources: [{ cursorFile, inboxFile, providerId: "slack" }]
    });
    expect(await provider.resolve()).toBeUndefined();
  });

  it("does NOT silently drop messages capped by totalLimit (regression for inbox-context iter 2)", async () => {
    // Two providers each contribute 6 fresh messages → 12 total.
    // With totalLimit = 6 the previous flow advanced cursors for all
    // 12 BEFORE applying the cap, marking the 6 unshipped ones as
    // "already injected" — they would never surface again. The new
    // round-robin cap surfaces 3+3 and advances cursors only for
    // those 6, so the remaining 6 stay visible on the next call.
    const slackInbox = join(workdir, "slack-inbox.json");
    const slackCursor = join(workdir, "slack-cursor.json");
    const discordInbox = join(workdir, "discord-inbox.json");
    const discordCursor = join(workdir, "discord-cursor.json");

    const slackMsgs: InboundMessage[] = Array.from({ length: 6 }, (_, index) => ({
      messageId: `s-${(index + 1).toString()}`,
      providerId: "slack",
      receivedAtIso: `2026-05-11T08:0${(index + 1).toString()}:00.000Z`,
      source: "C1",
      text: `slack ${(index + 1).toString()}`
    }));
    const discordMsgs: InboundMessage[] = Array.from({ length: 6 }, (_, index) => ({
      messageId: `d-${(index + 1).toString()}`,
      providerId: "discord",
      receivedAtIso: `2026-05-11T08:0${(index + 1).toString()}:00.000Z`,
      source: "D1",
      text: `discord ${(index + 1).toString()}`
    }));
    await writeInbox(slackInbox, slackMsgs);
    await writeInbox(discordInbox, discordMsgs);

    const provider = new FileBackedInboxContextProvider({
      sources: [
        { cursorFile: slackCursor, inboxFile: slackInbox, providerId: "slack" },
        { cursorFile: discordCursor, inboxFile: discordInbox, providerId: "discord" }
      ],
      totalLimit: 6
    });

    const first = await provider.resolve();
    expect(first?.messages).toHaveLength(6);
    // Round-robin: 3 slack + 3 discord (interleaved order varies)
    expect(first?.totalByProvider).toMatchObject({ discord: 3, slack: 3 });

    // The remaining 6 (3 per provider) MUST still surface on the next
    // resolve — they were not lost to the cap.
    const second = await provider.resolve();
    expect(second?.messages).toHaveLength(6);
    expect(second?.totalByProvider).toMatchObject({ discord: 3, slack: 3 });

    // Third call: cursors fully advanced for both providers → empty.
    const third = await provider.resolve();
    expect(third).toBeUndefined();
  });
});
