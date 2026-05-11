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
    const fresh = filterFresh(sampleMessages, { C1: "2026-05-11T08:00:00.000Z" }, 10);
    expect(fresh.map((m) => m.messageId)).toEqual(["2", "3"]);
  });

  it("caps to perProviderLimit (newest first)", () => {
    const fresh = filterFresh(sampleMessages, {}, 2);
    expect(fresh).toHaveLength(2);
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
    expect(cursor.C1).toBe("2026-05-11T08:05:00.000Z");
    expect(cursor.C2).toBe("2026-05-11T08:10:00.000Z");
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
