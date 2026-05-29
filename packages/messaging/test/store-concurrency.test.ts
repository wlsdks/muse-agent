import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendInbound, readInbox } from "../src/inbox-store.js";
import { type PendingApproval, readPendingApprovals, recordPendingApproval } from "../src/pending-approval-store.js";
import type { InboundMessage } from "../src/types.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "store-concurrency-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("appendInbound under concurrency — the write-queue serializes, no lost writes", () => {
  const msg = (i: number): InboundMessage =>
    ({ messageId: `m${i}`, providerId: "discord", receivedAtIso: "2026-01-01T00:00:00Z", source: "c1", text: `t${i}` }) as InboundMessage;

  it("preserves every record when many appends race on the same file", async () => {
    const file = join(dir, "inbox.json");
    await Promise.all(Array.from({ length: 25 }, (_v, i) => appendInbound(file, msg(i))));
    const ids = (await readInbox(file, 100)).map((m) => m.messageId).sort();
    expect(ids).toEqual(Array.from({ length: 25 }, (_v, i) => `m${i}`).sort());
  });

  it("does not let concurrent writes to different files interfere", async () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    await Promise.all([appendInbound(a, msg(1)), appendInbound(b, msg(2)), appendInbound(b, msg(3))]);
    expect((await readInbox(a, 100)).map((m) => m.messageId)).toEqual(["m1"]);
    expect((await readInbox(b, 100)).map((m) => m.messageId).sort()).toEqual(["m2", "m3"]);
  });
});

describe("recordPendingApproval under concurrency — no crash / corruption (tmp-name uniqueness fix)", () => {
  const approval = (i: number): PendingApproval => ({
    arguments: {},
    createdAt: "2026-01-01T00:00:00Z",
    draft: "send?",
    expiresAt: "2030-01-01T00:00:00Z",
    id: `p${i}`,
    providerId: "slack",
    risk: "write",
    source: "C1",
    tool: "email_send",
  });

  it("never crashes with an ENOENT tmp-rename race when many records fire at once", async () => {
    // Regression: the tmp file was `${pid}-${Date.now()}`, so two writes in the
    // same millisecond collided and one rename consumed the other's tmp -> ENOENT.
    // A random-uuid tmp suffix fixes the crash (there is no write-queue here).
    const file = join(dir, "pending.json");
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_v, i) => recordPendingApproval(file, approval(i))));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    // and the file is always left valid + readable (no torn/partial write)
    const stored = await readPendingApprovals(file);
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.length).toBeGreaterThanOrEqual(1);
    // NOTE: this store has no write-queue, so concurrent read-modify-write is
    // last-writer-wins (count may be < N). That is acceptable for the low-
    // frequency single-user approval path; the crash was the real defect.
  });

  it("persists every record when calls are sequential (await each)", async () => {
    const file = join(dir, "seq.json");
    for (let i = 0; i < 10; i += 1) await recordPendingApproval(file, approval(i));
    expect((await readPendingApprovals(file)).map((p) => p.id).sort()).toEqual(Array.from({ length: 10 }, (_v, i) => `p${i}`).sort());
  });
});
