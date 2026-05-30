import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscordProvider, MessagingProviderRegistry, SlackProvider, TelegramProvider } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { createMessagingPollDispatchers } from "../src/messaging-poll-dispatchers.js";
import type { MuseEnvironment } from "../src/index.js";

// Coverage for the messaging poll dispatchers (untested) — the agent's
// "check Telegram now" pull + the daemon's pollAll fan-out. Daily-reliability:
// per-channel fan-out must be FAIL-SOFT (one bad channel/provider doesn't black
// out the rest), a write-only channel (LINE / missing source) must raise a
// clear error not a silent ingested:0, and a real poll must append to the inbox.
// Exercises the real dispatcher with REAL providers (injected fetch) + tmp inbox.

const dir = mkdtempSync(join(tmpdir(), "muse-mpd-"));
let seq = 0;
const inboxPath = (): string => join(dir, `inbox-${(seq++).toString()}.json`);

const tgUpdates = (ids: readonly number[]): Response =>
  new Response(JSON.stringify({
    ok: true,
    result: ids.map((id) => ({ message: { chat: { id: 42 }, date: 1_700_000_000, from: { username: "bob" }, message_id: id, text: `msg-${id.toString()}` }, update_id: id }))
  }), { status: 200 });

const telegram = (fetchImpl: typeof fetch): TelegramProvider => new TelegramProvider({ fetch: fetchImpl, token: "T" });
const discord = (fetchImpl: typeof fetch): DiscordProvider => new DiscordProvider({ fetch: fetchImpl, token: "D" });
const slack = (fetchImpl: typeof fetch): SlackProvider => new SlackProvider({ fetch: fetchImpl, token: "S" });

describe("createMessagingPollDispatchers — pollNow", () => {
  it("polls Telegram and appends the fetched messages to the resolved inbox file", async () => {
    const inbox = inboxPath();
    const env = { MUSE_TELEGRAM_INBOX_FILE: inbox } as unknown as MuseEnvironment;
    const registry = new MessagingProviderRegistry([telegram(async () => tgUpdates([1, 2]))]);
    const result = await createMessagingPollDispatchers(env, registry).pollNow("telegram");

    expect(result.ingested).toBe(2);
    const written = readFileSync(inbox, "utf8");
    expect(written).toContain("msg-1");
    expect(written).toContain("msg-2");
  });

  it("throws PROVIDER_NOT_FOUND for an unregistered provider", async () => {
    const dispatch = createMessagingPollDispatchers({} as MuseEnvironment, new MessagingProviderRegistry([telegram(async () => tgUpdates([]))]));
    await expect(dispatch.pollNow("nope")).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("requires a source (channel id) for Discord and Slack — a clear error, not a silent ingested:0", async () => {
    const env = {} as MuseEnvironment;
    const dDiscord = createMessagingPollDispatchers(env, new MessagingProviderRegistry([discord(async () => new Response("[]", { status: 200 }))]));
    await expect(dDiscord.pollNow("discord")).rejects.toThrow(/source .*required for discord/u);
    const dSlack = createMessagingPollDispatchers(env, new MessagingProviderRegistry([slack(async () => new Response("{}", { status: 200 }))]));
    await expect(dSlack.pollNow("slack")).rejects.toThrow(/source .*required for slack/u);
  });
});

describe("createMessagingPollDispatchers — pollAll", () => {
  it("polls Telegram once and reports the per-provider ingest count", async () => {
    const env = { MUSE_TELEGRAM_INBOX_FILE: inboxPath() } as unknown as MuseEnvironment;
    const all = await createMessagingPollDispatchers(env, new MessagingProviderRegistry([telegram(async () => tgUpdates([1, 2, 3]))])).pollAll();
    expect(all.ingestedByProvider).toEqual({ telegram: 3 });
    expect(all.errors).toEqual([]);
  });

  it("fans Discord out over MUSE_DISCORD_POLL_CHANNELS and sums the per-channel ingest", async () => {
    const env = { MUSE_DISCORD_INBOX_FILE: inboxPath(), MUSE_DISCORD_POLL_CHANNELS: "c1,c2" } as unknown as MuseEnvironment;
    const fetchImpl = (async (url: string) => {
      const channel = new URL(String(url)).pathname.split("/").includes("c1") ? "c1" : "c2";
      return new Response(JSON.stringify([{ author: { username: "x" }, channel_id: channel, content: "yo", id: "1", timestamp: "2026-01-01T00:00:00Z" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const all = await createMessagingPollDispatchers(env, new MessagingProviderRegistry([discord(fetchImpl)])).pollAll();
    expect(all.ingestedByProvider.discord).toBe(2); // one per channel
  });

  it("is FAIL-SOFT: a provider whose poll throws is recorded in errors but does not black out pollAll", async () => {
    const env = { MUSE_TELEGRAM_INBOX_FILE: inboxPath() } as unknown as MuseEnvironment;
    const failing = telegram((async () => { throw new Error("network down"); }) as unknown as typeof fetch);
    const all = await createMessagingPollDispatchers(env, new MessagingProviderRegistry([failing])).pollAll();
    expect(all.errors.map((e) => e.providerId)).toEqual(["telegram"]);
    expect(all.errors[0]?.message).toContain("network down");
  });
});
