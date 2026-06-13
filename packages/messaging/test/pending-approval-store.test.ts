import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearPendingApproval,
  filterUnexpired,
  listPendingApprovals,
  type PendingApproval,
  readPendingApprovals,
  recordPendingApproval
} from "../src/pending-approval-store.js";

let dir: string;
let counter = 0;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "pending-approval-"));
  counter = 0;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const freshFile = () => join(dir, `pa-${counter++}.json`);

const entry = (id: string, over: Partial<PendingApproval> = {}): PendingApproval => ({
  arguments: { to: "x@example.com" },
  createdAt: "2026-01-01T00:00:00Z",
  draft: "Send the email?",
  expiresAt: "2030-01-01T00:00:00Z",
  id,
  providerId: "slack",
  risk: "write",
  source: "C1",
  tool: "email_send",
  ...over
});

describe("readPendingApprovals — tolerant read (corrupt file must degrade to empty, never throw)", () => {
  it("returns [] for a missing file", async () => {
    expect(await readPendingApprovals(join(dir, "nope.json"))).toEqual([]);
  });

  it("quarantines an unparseable file and returns []", async () => {
    const file = freshFile();
    await fs.writeFile(file, "{not valid json");
    expect(await readPendingApprovals(file)).toEqual([]);
    const quarantined = (await fs.readdir(dir)).some((f) => f.startsWith("pa-0.json.corrupt-"));
    expect(quarantined).toBe(true);
  });

  it("quarantines valid JSON that lacks a pending array", async () => {
    const file = freshFile();
    await fs.writeFile(file, JSON.stringify({ pending: "not-an-array" }));
    expect(await readPendingApprovals(file)).toEqual([]);
    expect((await fs.readdir(dir)).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  it("drops malformed entries, keeping only well-formed ones", async () => {
    const file = freshFile();
    await fs.writeFile(
      file,
      JSON.stringify({
        pending: [
          entry("ok"),
          { id: "missing-fields" },
          { ...entry("bad-risk"), risk: "delete" },
          { ...entry("array-args"), arguments: [] },
          { ...entry("null-args"), arguments: null }
        ]
      })
    );
    expect((await readPendingApprovals(file)).map((e) => e.id)).toEqual(["ok"]);
  });
});

describe("filterUnexpired — the live worklist (expired dropped, newest first, optional channel scope)", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("drops expired entries and sorts the rest newest-createdAt first", () => {
    const out = filterUnexpired(
      [
        entry("old", { createdAt: "2026-01-01T00:00:00Z" }),
        entry("new", { createdAt: "2026-05-01T00:00:00Z" }),
        entry("expired", { expiresAt: "2026-01-01T00:00:00Z" })
      ],
      now
    );
    expect(out.map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("treats an entry expiring exactly at now as expired (strict >)", () => {
    expect(filterUnexpired([entry("boundary", { expiresAt: now.toISOString() })], now)).toHaveLength(0);
  });

  it("keeps only entries matching the channel scope when one is given", () => {
    const out = filterUnexpired(
      [entry("slack-one"), entry("other", { providerId: "discord" }), entry("wrong-source", { source: "C2" })],
      now,
      { providerId: "slack", source: "C1" }
    );
    expect(out.map((e) => e.id)).toEqual(["slack-one"]);
  });

  it("returns an empty list unchanged", () => {
    expect(filterUnexpired([], now)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [entry("a", { createdAt: "2026-01-01T00:00:00Z" }), entry("b", { createdAt: "2026-05-01T00:00:00Z" })];
    const snapshot = input.map((e) => e.id);
    filterUnexpired(input, now);
    expect(input.map((e) => e.id)).toEqual(snapshot);
  });
});

describe("recordPendingApproval — append with a most-recent cap", () => {
  it("creates the file (and parent dir) and appends preserving order", async () => {
    const file = join(dir, "nested", "deep", "pa.json");
    await recordPendingApproval(file, entry("first"));
    await recordPendingApproval(file, entry("second"));
    expect((await readPendingApprovals(file)).map((e) => e.id)).toEqual(["first", "second"]);
  });

  it("caps the file to the 200 most recent entries", async () => {
    const file = freshFile();
    // Seed e0..e203 in ONE write (the store reads `{ pending: [...] }`), then a
    // single record of e204 pushes the count to 205 and triggers the cap — same
    // outcome as 205 sequential records but without the ~5s of disk round-trips
    // that flaked at the 5000ms boundary under concurrent-loop load.
    const seeded = Array.from({ length: 204 }, (_, i) => entry(`e${i}`));
    await fs.writeFile(file, JSON.stringify({ pending: seeded }), "utf8");
    await recordPendingApproval(file, entry("e204"));
    const stored = await readPendingApprovals(file);
    expect(stored).toHaveLength(200);
    expect(stored[0]!.id).toBe("e5"); // oldest 5 (e0..e4) dropped by the cap
    expect(stored[stored.length - 1]!.id).toBe("e204");
  });
});

describe("listPendingApprovals — read + filter in one call", () => {
  const now = () => new Date("2026-06-01T00:00:00Z");

  it("returns the unexpired worklist", async () => {
    const file = freshFile();
    await recordPendingApproval(file, entry("live"));
    await recordPendingApproval(file, entry("dead", { expiresAt: "2020-01-01T00:00:00Z" }));
    expect((await listPendingApprovals(file, now)).map((e) => e.id)).toEqual(["live"]);
  });

  it("scopes to one channel when asked", async () => {
    const file = freshFile();
    await recordPendingApproval(file, entry("slack-one"));
    await recordPendingApproval(file, entry("discord-one", { providerId: "discord" }));
    expect((await listPendingApprovals(file, now, { providerId: "slack", source: "C1" })).map((e) => e.id)).toEqual(["slack-one"]);
  });

  it("returns [] for a missing file", async () => {
    expect(await listPendingApprovals(join(dir, "absent.json"), now)).toEqual([]);
  });
});

describe("clearPendingApproval — remove by id, pruning expired as it rewrites", () => {
  const now = () => new Date("2026-06-01T00:00:00Z");

  it("removes the matching id and reports true", async () => {
    const file = freshFile();
    await recordPendingApproval(file, entry("keep"));
    await recordPendingApproval(file, entry("remove"));
    expect(await clearPendingApproval(file, "remove", now)).toBe(true);
    expect((await readPendingApprovals(file)).map((e) => e.id)).toEqual(["keep"]);
  });

  it("reports false and changes nothing when the id is absent and nothing is expired", async () => {
    const file = freshFile();
    await recordPendingApproval(file, entry("only"));
    expect(await clearPendingApproval(file, "ghost", now)).toBe(false);
    expect((await readPendingApprovals(file)).map((e) => e.id)).toEqual(["only"]);
  });

  it("still reports true and prunes expired entries even when the id is absent", async () => {
    const file = freshFile();
    await recordPendingApproval(file, entry("live"));
    await recordPendingApproval(file, entry("expired", { expiresAt: "2020-01-01T00:00:00Z" }));
    expect(await clearPendingApproval(file, "ghost", now)).toBe(true);
    expect((await readPendingApprovals(file)).map((e) => e.id)).toEqual(["live"]);
  });
});
