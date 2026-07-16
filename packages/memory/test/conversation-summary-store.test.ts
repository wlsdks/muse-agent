import { afterAll, describe, expect, it } from "vitest";
import { withFileLock } from "@muse/shared";

import {
  InMemoryConversationSummaryStore,
  createConversationSummaryInsert,
  mapConversationSummaryRow
} from "../src/memory-conversation-summary-store.js";
import type { ConversationSummary } from "../src/index.js";

// Coverage for the conversation-summary store (untested module): the in-memory
// CRUD + normalize, and the pure row-builder/mapper round-trip that serializes
// structured facts for persistence. A dropped or mis-serialized summary loses
// the compaction context the agent relies on across a long session. The Kysely
// store's SQL upsert is deferred to the testcontainers Postgres item; the row
// builder it shares IS covered here.

const summary = (sessionId: string, extra: Partial<ConversationSummary> = {}): ConversationSummary =>
  ({ facts: [], narrative: "a chat", sessionId, summarizedUpToIndex: 0, ...extra }) as ConversationSummary;

describe("InMemoryConversationSummaryStore", () => {
  it("normalizes on save (trims narrative/userId, floors the index) and stamps created/updated from the clock", () => {
    const t = 1000;
    const store = new InMemoryConversationSummaryStore({ now: () => new Date(t) });
    const saved = store.save(summary("s1", { narrative: "  hello  ", summarizedUpToIndex: 3.9, userId: "  u1  " }));
    expect(saved.narrative).toBe("hello");
    expect(saved.summarizedUpToIndex).toBe(3);
    expect(saved.userId).toBe("u1");
    expect(saved.createdAt.getTime()).toBe(1000);
    expect(saved.updatedAt.getTime()).toBe(1000);
  });

  it("normalizes non-finite or negative summary indexes before persistence", () => {
    const store = new InMemoryConversationSummaryStore({ now: () => new Date(1000) });

    expect(store.save(summary("nan", { summarizedUpToIndex: Number.NaN })).summarizedUpToIndex).toBe(0);
    expect(store.save(summary("infinite", { summarizedUpToIndex: Number.POSITIVE_INFINITY })).summarizedUpToIndex).toBe(0);
    expect(store.save(summary("negative", { summarizedUpToIndex: -5 })).summarizedUpToIndex).toBe(0);
  });

  it("normalizes invalid runtime timestamps before a later persistence boundary can throw", () => {
    const now = new Date(1000);
    const invalid = new Date("not-a-date");
    const input = summary("invalid-dates", {
      createdAt: invalid,
      facts: [{ category: "GENERAL", extractedAt: invalid, key: "k", value: "v" }],
      updatedAt: invalid
    });
    const store = new InMemoryConversationSummaryStore({ now: () => now });

    const saved = store.save(input);
    const insert = createConversationSummaryInsert(input, { now: () => now });

    expect(saved.createdAt.getTime()).toBe(1000);
    expect(saved.updatedAt.getTime()).toBe(1000);
    expect(saved.facts[0]?.extractedAt.getTime()).toBe(1000);
    expect(insert.created_at.getTime()).toBe(1000);
    expect(insert.updated_at.getTime()).toBe(1000);
    expect((insert.facts_json as Array<{ extractedAt: string }>)[0]?.extractedAt).toBe(now.toISOString());
  });

  it("preserves the original createdAt on re-save but advances updatedAt", () => {
    let t = 1000;
    const store = new InMemoryConversationSummaryStore({ now: () => new Date(t) });
    store.save(summary("s1"));
    t = 5000;
    const resaved = store.save(summary("s1", { narrative: "updated" }));
    expect(resaved.createdAt.getTime()).toBe(1000);
    expect(resaved.updatedAt.getTime()).toBe(5000);
    expect(store.get("s1")?.narrative).toBe("updated");
  });

  it("treats a blank userId as undefined and returns undefined for a missing get", () => {
    const store = new InMemoryConversationSummaryStore({ now: () => new Date(1000) });
    expect(store.save(summary("s1", { userId: "   " })).userId).toBeUndefined();
    expect(store.get("missing")).toBeUndefined();
  });

  it("delete returns whether a row existed", () => {
    const store = new InMemoryConversationSummaryStore({ now: () => new Date(1000) });
    store.save(summary("s1"));
    expect(store.delete("s1")).toBe(true);
    expect(store.delete("s1")).toBe(false);
  });

  it("listAll sorts by updatedAt desc, filters by userId, and clamps the limit", () => {
    let t = 1000;
    const store = new InMemoryConversationSummaryStore({ now: () => new Date(t) });
    t = 1000; store.save(summary("s1", { userId: "u1" }));
    t = 3000; store.save(summary("s2", { userId: "u2" }));
    t = 2000; store.save(summary("s3", { userId: "u1" }));
    expect(store.listAll().map((s) => s.sessionId)).toEqual(["s2", "s3", "s1"]); // updatedAt desc
    expect(store.listAll({ userId: "u1" }).map((s) => s.sessionId)).toEqual(["s3", "s1"]);
    expect(store.listAll({ limit: 1 }).map((s) => s.sessionId)).toEqual(["s2"]);
  });
});

describe("createConversationSummaryInsert / mapConversationSummaryRow", () => {
  const facts = [
    { category: "ENTITY" as const, extractedAt: new Date(1500), key: " spouse ", value: " Mina " },
    { category: "DECISION" as const, extractedAt: new Date(1600), key: "ship", value: "v1" }
  ];

  it("round-trips structured facts (trimmed key/value, category, ISO extractedAt) through insert → map", () => {
    const input = summary("s", { createdAt: new Date(1000), facts, summarizedUpToIndex: 2, updatedAt: new Date(2000) });
    const insert = createConversationSummaryInsert(input, { now: () => new Date(9999) });
    expect(insert.user_id).toBeNull();
    const mapped = mapConversationSummaryRow({
      created_at: insert.created_at,
      facts_json: insert.facts_json,
      narrative: insert.narrative,
      session_id: insert.session_id,
      summarized_up_to: insert.summarized_up_to,
      updated_at: insert.updated_at,
      user_id: null
    } as Parameters<typeof mapConversationSummaryRow>[0]);
    expect(mapped.facts).toEqual([
      { category: "ENTITY", extractedAt: new Date(1500), key: "spouse", value: "Mina" },
      { category: "DECISION", extractedAt: new Date(1600), key: "ship", value: "v1" }
    ]);
    expect(mapped.userId).toBeUndefined();
  });

  it("coerces an unknown fact category to GENERAL and parses a JSON-string facts_json column", () => {
    const mapped = mapConversationSummaryRow({
      created_at: new Date(0),
      facts_json: '[{"key":"k","value":"v","category":"BOGUS","extractedAt":"2026-01-01T00:00:00Z"}]',
      narrative: "n",
      session_id: "s",
      summarized_up_to: 0,
      updated_at: new Date(0),
      user_id: "u"
    } as Parameters<typeof mapConversationSummaryRow>[0]);
    expect(mapped.facts).toEqual([{ category: "GENERAL", extractedAt: new Date("2026-01-01T00:00:00Z"), key: "k", value: "v" }]);
    expect(mapped.userId).toBe("u");
  });

  it("maps corrupt persisted timestamps to epoch dates instead of exposing invalid Date values", () => {
    const mapped = mapConversationSummaryRow({
      created_at: "not-a-date",
      facts_json: '[{"key":"k","value":"v","category":"GENERAL","extractedAt":"not-a-date"}]',
      narrative: "n",
      session_id: "s",
      summarized_up_to: 0,
      updated_at: "not-a-date",
      user_id: null
    } as Parameters<typeof mapConversationSummaryRow>[0]);

    expect(mapped.createdAt.getTime()).toBe(0);
    expect(mapped.updatedAt.getTime()).toBe(0);
    expect(mapped.facts[0]?.extractedAt.getTime()).toBe(0);
  });
});

import { mkdtempSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FileConversationSummaryStore } from "../src/memory-conversation-summary-store.js";

describe("FileConversationSummaryStore — cross-session persistence (the CLI default-store fix)", () => {
  let dirs: string[] = [];
  const freshFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "muse-summary-"));
    dirs.push(dir);
    return join(dir, "conversation-summaries.json");
  };

  it("a summary saved by one instance is recalled by a FRESH instance on the same file (in-memory would lose it)", async () => {
    const file = freshFile();
    const s1 = new FileConversationSummaryStore({ file, now: () => new Date(1000) });
    await s1.save(summary("sess-1", {
      narrative: "user prefers morning meetings",
      summarizedUpToIndex: 3,
      userId: "u1",
      facts: [{ key: "tz", value: "KST", category: "GENERAL", extractedAt: new Date(500) }]
    }));

    // a brand-new instance = a new `muse ask`/`chat` PROCESS reading the same file
    const s2 = new FileConversationSummaryStore({ file });
    const got = await s2.get("sess-1");
    expect(got?.narrative).toBe("user prefers morning meetings");
    expect(got?.createdAt instanceof Date).toBe(true);     // Date round-trips via ISO
    expect(got?.createdAt.getTime()).toBe(1000);
    expect(got?.facts[0]?.value).toBe("KST");
    expect(got?.facts[0]?.extractedAt.getTime()).toBe(500); // nested fact Date round-trips

    const all = await s2.listAll({ userId: "u1" });
    expect(all).toHaveLength(1);
  });

  it("delete persists across instances; a missing file reads as empty (best-effort, never throws)", async () => {
    const file = freshFile();
    const s1 = new FileConversationSummaryStore({ file });
    await s1.save(summary("sess-x", { narrative: "to be removed" }));
    expect(await new FileConversationSummaryStore({ file }).delete("sess-x")).toBe(true);
    expect(await new FileConversationSummaryStore({ file }).get("sess-x")).toBeUndefined();

    // unwritten file ⇒ empty, no throw
    expect(await new FileConversationSummaryStore({ file: join(tmpdir(), `muse-absent-${Date.now().toString()}.json`) }).listAll()).toEqual([]);
  });

  it("serializes concurrent saves across store instances without losing summaries", async () => {
    const file = freshFile();
    const sessionIds = Array.from({ length: 12 }, (_, index) => `session-${index.toString()}`);

    await Promise.all(sessionIds.map((sessionId, index) =>
      new FileConversationSummaryStore({ file, now: () => new Date(1_000 + index) }).save(summary(sessionId))
    ));

    const stored = await new FileConversationSummaryStore({ file }).listAll({ limit: 100 });
    expect(stored.map((entry) => entry.sessionId).sort()).toEqual([...sessionIds].sort());
  });

  it("waits for an external process lock before mutating the summary file", async () => {
    const file = freshFile();
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const heldLock = withFileLock(file, async () => {
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;

    let settled = false;
    const pendingSave = new FileConversationSummaryStore({ file }).save(summary("locked-summary")).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    release.resolve();
    await Promise.all([heldLock, pendingSave]);
    expect(await new FileConversationSummaryStore({ file }).get("locked-summary")).toBeDefined();
  });

  it("quarantines a corrupt store before save replaces it, preserving recoverable raw data", async () => {
    const file = freshFile();
    const corrupt = "{not valid JSON";
    await writeFile(file, corrupt, "utf8");

    await new FileConversationSummaryStore({ file }).save(summary("recovered", { narrative: "fresh summary" }));

    const quarantined = (await readdir(dirname(file))).find((name) => name.startsWith("conversation-summaries.json.corrupt-"));
    expect(quarantined).toBeDefined();
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(join(dirname(file), quarantined!), "utf8"))).toBe(corrupt);
    expect(await new FileConversationSummaryStore({ file }).get("recovered")).toMatchObject({ narrative: "fresh summary" });
  });

  it("skips malformed summaries and facts so a later save can recover the valid entries", async () => {
    const file = freshFile();
    await writeFile(file, JSON.stringify({
      summaries: [
        {
          createdAt: "not-a-date",
          facts: [],
          narrative: "broken",
          sessionId: "broken-summary",
          summarizedUpToIndex: 0,
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        {
          createdAt: "2026-01-01T00:00:00.000Z",
          facts: [
            { category: "GENERAL", extractedAt: "not-a-date", key: "broken", value: "fact" },
            { category: "ENTITY", extractedAt: "2026-01-01T00:00:00.000Z", key: "valid", value: "fact" }
          ],
          narrative: "valid",
          sessionId: "valid-summary",
          summarizedUpToIndex: 1,
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    }), "utf8");

    const store = new FileConversationSummaryStore({ file });
    await store.save(summary("recovered-summary", { narrative: "safe to persist" }));

    const recovered = await new FileConversationSummaryStore({ file }).listAll({ limit: 10 });
    expect(recovered.map((entry) => entry.sessionId).sort()).toEqual(["recovered-summary", "valid-summary"]);
    expect(recovered.find((entry) => entry.sessionId === "valid-summary")?.facts).toEqual([
      expect.objectContaining({ key: "valid", value: "fact" })
    ]);
  });

  it("persists invalid runtime timestamps with its clock fallback", async () => {
    const file = freshFile();
    const now = new Date(1000);
    const invalid = new Date("not-a-date");
    const store = new FileConversationSummaryStore({ file, now: () => now });

    await expect(store.save(summary("invalid-runtime-date", {
      createdAt: invalid,
      facts: [{ category: "GENERAL", extractedAt: invalid, key: "k", value: "v" }],
      updatedAt: invalid
    }))).resolves.toMatchObject({ createdAt: now, updatedAt: now });

    await expect(new FileConversationSummaryStore({ file }).get("invalid-runtime-date")).resolves.toMatchObject({
      createdAt: now,
      updatedAt: now
    });
  });

  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { force: true, recursive: true })));
    dirs = [];
  });
});
