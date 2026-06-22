import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { writeTasks } from "@muse/stores";
import { runDueProactiveNotices } from "@muse/proactivity";
import { LocalDirNotesProvider, createNotesInvestigator } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

function fakeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

/**
 * P2 target audit (the P→P seam check): the two P2 bullets must
 * COMPOSE into one non-spammy proactive experience on the real
 * channel, not just pass in isolation. P2-b1's dedupe test has no
 * investigator; P2-b2's prep test is single-tick. The realistic
 * daemon ticks repeatedly while an item stays imminent — so the
 * seam to prove is: the anticipatorily-prepped notice (b2) reaches
 * the REAL channel exactly ONCE (b1) and the real dedupe sidecar
 * suppresses every later tick (the P2 "not noisy" quality bar),
 * even though investigate-appended text changes the rendered body.
 */
describe("P2 audit — anticipatory prep delivers to the real channel once and never re-spams", () => {
  it("fires the prepped notice on tick 1 and the real dedupe sidecar suppresses ticks 2 and 3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-p2-seam-"));
    const sidecarFile = join(dir, "proactive-fired.json");
    const tasksFile = join(dir, "tasks.json");
    await writeTasks(tasksFile, [
      {
        createdAt: "2026-05-18T08:00:00.000Z",
        dueAt: "2026-05-18T09:05:00.000Z",
        id: "t-q3",
        status: "open",
        title: "Q3 review"
      }
    ]);

    const notesDir = mkdtempSync(join(tmpdir(), "muse-p2-seam-notes-"));
    writeFileSync(join(notesDir, "q3-review-plan.md"), "# Plan\nQ3 review agenda and quarterly metrics\n");
    writeFileSync(join(notesDir, "groceries.md"), "milk, eggs, bread\n");
    const notes = new LocalDirNotesProvider({ notesDir });

    const posts: { url: string; body: string }[] = [];
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url, init) => {
        posts.push({ body: String(init?.body), url: String(url) });
        return fakeJsonResponse({ ok: true, result: { message_id: 99 } });
      },
      token: "BOT-TOK"
    });
    const messagingRegistry = new MessagingProviderRegistry([telegram]);

    const NOW = new Date("2026-05-18T09:00:00.000Z");
    const tick = () =>
      runDueProactiveNotices({
        destination: "555",
        investigate: createNotesInvestigator((q, l) => notes.search(q, l)),
        messagingRegistry,
        now: () => NOW,
        providerId: "telegram",
        sidecarFile,
        tasksFile
      });

    const first = await tick();
    expect(first).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://tg.test/botBOT-TOK/sendMessage");
    const body = JSON.parse(posts[0]!.body) as { chat_id: string; text: string };
    expect(body.chat_id).toBe("555");
    expect(body.text).toContain("Q3 review");
    expect(body.text).toContain("due in 5 min");
    expect(body.text).toContain("Related notes:");
    expect(body.text).toContain("q3-review-plan.md");
    expect(body.text).not.toContain("groceries.md");

    // The item stays imminent: two more ticks must NOT re-POST. The
    // investigate-appended text changes the rendered body, so this
    // also proves the dedupe key is item-derived, not body-derived
    // — the composed P2 flow is not noisy on the real channel.
    const second = await tick();
    const third = await tick();
    expect(second).toMatchObject({ fired: 0, imminent: 1 });
    expect(third).toMatchObject({ fired: 0, imminent: 1 });
    expect(posts).toHaveLength(1);
  });
});
