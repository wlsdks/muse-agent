import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { addObjective, type StandingObjective } from "@muse/stores";
import { runDueSituationalBriefing } from "./situational-briefing-loop.js";
import type { BriefingImminent } from "./situational-briefing.js";

/**
 * P8 target audit (the P→P seam check). P8's bullets ARE a
 * composed pipeline (b1 synthesise → b2 deliver-deduped). The
 * isolated tests cover each piece; the seam the audit must prove
 * is the WHOLE situational picture — upcoming + needs-you +
 * still-tracking, finished excluded — assembled from the REAL
 * objectives store and delivered intact over the REAL channel in
 * ONE message, then deduped within the window.
 */
function fakeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function objective(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-05-19T08:00:00.000Z",
    id: "obj",
    kind: "until",
    spec: "watch the deploy until green",
    status: "active",
    userId: "stark",
    ...overrides
  };
}

describe("P8 audit — the full situational picture is synthesised from the real store and delivered intact over the real channel", () => {
  it("upcoming + needs-you + still-tracking compose into ONE real-channel POST; finished excluded; deduped in-window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-p8-seam-"));
    const objectivesFile = join(dir, "objectives.json");
    const sidecarFile = join(dir, "briefing-fired.json");

    await addObjective(objectivesFile, objective({ id: "track", spec: "watch the deploy until green" }));
    await addObjective(
      objectivesFile,
      objective({ id: "esc", resolution: "max attempts exhausted", spec: "open the changelog issue", status: "escalated" })
    );
    await addObjective(objectivesFile, objective({ id: "fin", spec: "this finished objective", status: "done" }));

    const NOW = new Date("2026-05-19T09:00:00.000Z");
    const imminent: BriefingImminent[] = [
      { kind: "calendar", startsAt: new Date(NOW.getTime() + 45 * 60_000), title: "Q3 review" },
      { kind: "task", startsAt: new Date(NOW.getTime() + 10 * 60_000), title: "submit the report" }
    ];

    const posts: { url: string; body: string }[] = [];
    const messagingRegistry = new MessagingProviderRegistry([
      new TelegramProvider({
        baseUrl: "https://tg.test",
        fetch: async (url, init) => {
          posts.push({ body: String(init?.body), url: String(url) });
          return fakeJsonResponse({ ok: true, result: { message_id: 1 } });
        },
        token: "BOT-TOK"
      })
    ]);

    const opts = {
      destination: "555",
      imminent,
      messagingRegistry,
      now: () => NOW,
      objectivesFile,
      providerId: "telegram",
      sidecarFile,
      windowMs: 4 * 60 * 60_000
    };

    const first = await runDueSituationalBriefing(opts);
    expect(first).toEqual({ delivered: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://tg.test/botBOT-TOK/sendMessage");
    const text = (JSON.parse(posts[0]!.body) as { chat_id: string; text: string }).text;

    // ONE message, the whole situation, soonest-first upcoming.
    expect(text).toContain("[Briefing]");
    expect(text.indexOf("submit the report")).toBeLessThan(text.indexOf("Q3 review"));
    expect(text).toContain("in 10 min: submit the report");
    expect(text).toContain("in 45 min: Q3 review");
    // Escalated → "Needs you" with its resolution.
    expect(text).toContain("Needs you:");
    expect(text).toContain("⚠ open the changelog issue — max attempts exhausted");
    // Active → "Still tracking".
    expect(text).toContain("Still tracking:");
    expect(text).toContain("watch the deploy until green");
    // The finished objective is NOT surfaced.
    expect(text).not.toContain("this finished objective");

    // Same situation-window: the real sidecar dedupes — no re-POST.
    const second = await runDueSituationalBriefing(opts);
    expect(second).toEqual({ delivered: 0, reason: "in-window" });
    expect(posts).toHaveLength(1);
  });
});
