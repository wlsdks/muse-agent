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
 * P2-b1 — the proactive daemon must deliver to a REAL channel API,
 * not a fake registry. A real `TelegramProvider` builds the real
 * Bot API request; only the HTTP boundary is faked, so the outbound
 * POST (URL + chat_id + text) is asserted exactly as Telegram would
 * receive it. The audit note flagged that every prior firing test
 * injected a fake registry (unit-only) — this closes that.
 */
describe("runDueProactiveNotices — contract-faithful channel delivery", () => {
  function fixtures() {
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-deliver-"));
    return {
      sidecarFile: join(dir, "proactive-fired.json"),
      tasksFile: join(dir, "tasks.json")
    };
  }

  const NOW = new Date("2026-05-18T09:00:00.000Z");
  const dueSoonTask = {
    createdAt: "2026-05-18T08:00:00.000Z",
    dueAt: "2026-05-18T09:05:00.000Z",
    id: "t-q3",
    status: "open" as const,
    title: "Send the Q3 budget memo"
  };

  it("POSTs an imminent-task notice over the real provider's HTTP send and dedupes on the next tick", async () => {
    const { sidecarFile, tasksFile } = fixtures();
    await writeTasks(tasksFile, [dueSoonTask]);

    const posts: { url: string; body: string }[] = [];
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url, init) => {
        posts.push({ body: String(init?.body), url: String(url) });
        return fakeJsonResponse({ ok: true, result: { message_id: 11 } });
      },
      token: "BOT-TOK"
    });
    const messagingRegistry = new MessagingProviderRegistry([telegram]);

    const summary = await runDueProactiveNotices({
      destination: "555",
      messagingRegistry,
      now: () => NOW,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });

    expect(summary).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://tg.test/botBOT-TOK/sendMessage");
    const body = JSON.parse(posts[0]!.body) as { chat_id: string; text: string };
    expect(body.chat_id).toBe("555");
    expect(body.text).toContain("Send the Q3 budget memo");
    expect(body.text).toContain("due in 5 min");

    // The dedupe sidecar is real (not a unit mock): a second tick at
    // the same time must NOT re-POST the same notice.
    const second = await runDueProactiveNotices({
      destination: "555",
      messagingRegistry,
      now: () => NOW,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(second).toMatchObject({ fired: 0, imminent: 1 });
    expect(posts).toHaveLength(1);
  });

  it("delivers anticipatory prep (the related doc) in the POST when an investigator is wired", async () => {
    const { sidecarFile, tasksFile } = fixtures();
    await writeTasks(tasksFile, [{ ...dueSoonTask, title: "Q3 review" }]);

    const notesDir = mkdtempSync(join(tmpdir(), "muse-proactive-notes-"));
    writeFileSync(join(notesDir, "q3-review-plan.md"), "# Plan\nQ3 review agenda and quarterly metrics\n");
    writeFileSync(join(notesDir, "groceries.md"), "milk, eggs, bread\n");
    const notes = new LocalDirNotesProvider({ notesDir });

    const posts: { url: string; body: string }[] = [];
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url, init) => {
        posts.push({ body: String(init?.body), url: String(url) });
        return fakeJsonResponse({ ok: true, result: { message_id: 12 } });
      },
      token: "BOT-TOK"
    });
    const messagingRegistry = new MessagingProviderRegistry([telegram]);

    const summary = await runDueProactiveNotices({
      destination: "555",
      investigate: createNotesInvestigator((q, l) => notes.search(q, l)),
      messagingRegistry,
      now: () => NOW,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });

    expect(summary).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://tg.test/botBOT-TOK/sendMessage");
    const body = JSON.parse(posts[0]!.body) as { chat_id: string; text: string };
    // The imminent-item announcement AND the anticipatorily prepped
    // doc both ride the same real-channel POST — "meeting in 15 min
    // — here's the doc".
    expect(body.text).toContain("Q3 review");
    expect(body.text).toContain("due in 5 min");
    expect(body.text).toContain("Related notes:");
    expect(body.text).toContain("q3-review-plan.md");
    expect(body.text).not.toContain("groceries.md");
  });
});
