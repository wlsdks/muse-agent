import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  authorizeFollowupTriage,
  FollowupTriageAuthorizationLockError,
  FollowupTriageAuthorizationStoreError,
  readFollowupTriageLedgerStrict
} from "../src/personal-followup-triage-authorization-store.js";
import { writeFollowups, type PersistedFollowup } from "../src/personal-followups-store.js";

const BASE = new Date("2026-07-22T00:00:00.000Z");

function followup(id: string, overrides: Partial<PersistedFollowup> = {}): PersistedFollowup {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    scheduledFor: "2026-07-01T00:00:00.000Z",
    status: "scheduled",
    summary: `private ${id}`,
    userId: "owner",
    ...overrides
  };
}

async function fixture(items: readonly PersistedFollowup[] = [followup("fu_a")]) {
  const dir = await mkdtemp(join(tmpdir(), "muse-followup-auth-"));
  const followupsFile = join(dir, "followups.json");
  const ledgerFile = join(dir, "followup-triage.json");
  await writeFollowups(followupsFile, items);
  return { dir, followupsFile, ledgerFile };
}

function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => Array.isArray(input)
    ? input.map(normalize)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.keys(input as Record<string, unknown>).sort()
        .map((key) => [key, normalize((input as Record<string, unknown>)[key])]))
      : input;
  return JSON.stringify(normalize(value));
}

function rehash(event: Record<string, unknown>): void {
  const { hash: _hash, ...withoutHash } = event;
  event.hash = createHash("sha256").update(canonical(withoutHash), "utf8").digest("hex");
}

describe("follow-up triage persisted authorization", () => {
  it("persists an owner-only hash-chained authorization without mutating follow-ups or leaking bearer/private text", async () => {
    const f = await fixture([followup("fu_a", { summary: "do not persist this summary" })]);
    const before = await readFile(f.followupsFile, "utf8");
    const authorization = await authorizeFollowupTriage({
      action: "dismiss",
      followupsFile: f.followupsFile,
      ids: ["fu_a"],
      ledgerFile: f.ledgerFile,
      now: () => BASE
    });

    expect(authorization.schemaVersion).toBe("muse.followup-triage-authorization/v1");
    expect(authorization.operationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(authorization.confirmToken).toMatch(/^ft1_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u);
    expect(authorization.preview.changes[0]?.after).toMatchObject({
      cancelReason: "backlog-triage-dismissed",
      status: "cancelled"
    });
    expect(await readFile(f.followupsFile, "utf8")).toBe(before);

    const raw = await readFile(f.ledgerFile, "utf8");
    expect(raw).not.toContain(authorization.confirmToken);
    expect(raw).not.toContain(authorization.confirmToken.split("_").at(-1));
    expect(raw).not.toContain("do not persist this summary");
    expect(raw).not.toContain("owner");
    expect((await stat(f.ledgerFile)).mode & 0o777).toBe(0o600);
    const ledger = await readFollowupTriageLedgerStrict(f.ledgerFile);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]).toMatchObject({
      action: "dismiss",
      ids: ["fu_a"],
      operationId: authorization.operationId,
      sourceDigest: authorization.preview.sourceDigest,
      type: "previewed"
    });
  });

  it("records only hashes for draft content and canonical snooze metadata", async () => {
    const draftFixture = await fixture([followup("fu_draft", { summary: "draft private words" })]);
    const draft = await authorizeFollowupTriage({
      action: "draft-digest",
      followupsFile: draftFixture.followupsFile,
      ids: ["fu_draft"],
      ledgerFile: draftFixture.ledgerFile,
      now: () => BASE
    });
    const draftEvent = (await readFollowupTriageLedgerStrict(draftFixture.ledgerFile)).events[0]!;
    expect(draftEvent.draftDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readFile(draftFixture.ledgerFile, "utf8")).not.toContain(draft.preview.digestDraft!);

    const snoozeFixture = await fixture([followup("fu_snooze")]);
    await authorizeFollowupTriage({
      action: "snooze",
      followupsFile: snoozeFixture.followupsFile,
      ids: ["fu_snooze"],
      ledgerFile: snoozeFixture.ledgerFile,
      now: () => BASE,
      snoozeAt: "2026-07-23T09:30:00+09:00"
    });
    expect((await readFollowupTriageLedgerStrict(snoozeFixture.ledgerFile)).events[0]?.snoozeAt)
      .toBe("2026-07-23T00:30:00.000Z");
  });

  it("creates no ledger or source mutation when one selected item is invalid", async () => {
    const f = await fixture([
      followup("due"),
      followup("future", { scheduledFor: "2026-08-01T00:00:00.000Z" })
    ]);
    const before = await readFile(f.followupsFile, "utf8");
    await expect(authorizeFollowupTriage({
      action: "dismiss",
      followupsFile: f.followupsFile,
      ids: ["due", "future"],
      ledgerFile: f.ledgerFile,
      now: () => BASE
    })).rejects.toThrow("not scheduled and due");
    expect(await readFile(f.followupsFile, "utf8")).toBe(before);
    await expect(readFile(f.ledgerFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed under the live firing lock before preview or ledger work", async () => {
    const f = await fixture();
    await writeFile(`${f.followupsFile}.firing.lock`, "live-holder", "utf8");
    await expect(authorizeFollowupTriage({
      action: "retain",
      followupsFile: f.followupsFile,
      ids: ["fu_a"],
      ledgerFile: f.ledgerFile,
      now: () => BASE
    })).rejects.toBeInstanceOf(FollowupTriageAuthorizationLockError);
    await expect(readFile(f.ledgerFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns no usable token when authorization fails before or after persistence", async () => {
    const before = await fixture();
    await expect(authorizeFollowupTriage({
      action: "retain",
      failpoint: (point) => { if (point === "before-ledger") throw new Error("before-ledger"); },
      followupsFile: before.followupsFile,
      ids: ["fu_a"],
      ledgerFile: before.ledgerFile,
      now: () => BASE
    })).rejects.toThrow("before-ledger");
    await expect(readFile(before.ledgerFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const after = await fixture();
    await expect(authorizeFollowupTriage({
      action: "retain",
      failpoint: (point) => { if (point === "after-ledger") throw new Error("after-ledger"); },
      followupsFile: after.followupsFile,
      ids: ["fu_a"],
      ledgerFile: after.ledgerFile,
      now: () => BASE
    })).rejects.toThrow("after-ledger");
    const raw = await readFile(after.ledgerFile, "utf8");
    expect(raw).not.toContain("ft1_");
    expect((await readFollowupTriageLedgerStrict(after.ledgerFile)).events).toHaveLength(1);
  });

  it("rejects malformed and tampered ledgers without rewrite", async () => {
    const malformed = await fixture();
    await writeFile(malformed.ledgerFile, "{", "utf8");
    await expect(readFollowupTriageLedgerStrict(malformed.ledgerFile))
      .rejects.toBeInstanceOf(FollowupTriageAuthorizationStoreError);
    expect(await readFile(malformed.ledgerFile, "utf8")).toBe("{");

    const tampered = await fixture();
    await authorizeFollowupTriage({
      action: "retain",
      followupsFile: tampered.followupsFile,
      ids: ["fu_a"],
      ledgerFile: tampered.ledgerFile,
      now: () => BASE
    });
    const raw = await readFile(tampered.ledgerFile, "utf8");
    const changed = raw.replace(/"sourceDigest": "[0-9a-f]{64}"/u, `"sourceDigest": "${"0".repeat(64)}"`);
    await writeFile(tampered.ledgerFile, changed, "utf8");
    await expect(readFollowupTriageLedgerStrict(tampered.ledgerFile))
      .rejects.toThrow("hash chain");
    expect(await readFile(tampered.ledgerFile, "utf8")).toBe(changed);
  });

  it("rejects correctly rehashed duplicate event identities and non-exact ids", async () => {
    const duplicate = await fixture([followup("fu_a"), followup("fu_b")]);
    await authorizeFollowupTriage({
      action: "retain",
      followupsFile: duplicate.followupsFile,
      ids: ["fu_a"],
      ledgerFile: duplicate.ledgerFile,
      now: () => BASE
    });
    await authorizeFollowupTriage({
      action: "retain",
      followupsFile: duplicate.followupsFile,
      ids: ["fu_b"],
      ledgerFile: duplicate.ledgerFile,
      now: () => BASE
    });
    const duplicateLedger = JSON.parse(await readFile(duplicate.ledgerFile, "utf8")) as {
      events: Record<string, unknown>[];
      schemaVersion: string;
    };
    duplicateLedger.events[1]!.eventId = duplicateLedger.events[0]!.eventId;
    duplicateLedger.events[1]!.operationId = randomUUID();
    rehash(duplicateLedger.events[1]!);
    const duplicateRaw = `${JSON.stringify(duplicateLedger, null, 2)}\n`;
    await writeFile(duplicate.ledgerFile, duplicateRaw, "utf8");
    await expect(readFollowupTriageLedgerStrict(duplicate.ledgerFile)).rejects.toThrow("hash chain");
    expect(await readFile(duplicate.ledgerFile, "utf8")).toBe(duplicateRaw);

    const inexact = await fixture();
    await authorizeFollowupTriage({
      action: "retain",
      followupsFile: inexact.followupsFile,
      ids: ["fu_a"],
      ledgerFile: inexact.ledgerFile,
      now: () => BASE
    });
    const inexactLedger = JSON.parse(await readFile(inexact.ledgerFile, "utf8")) as {
      events: Record<string, unknown>[];
      schemaVersion: string;
    };
    inexactLedger.events[0]!.ids = [" fu_a "];
    rehash(inexactLedger.events[0]!);
    const inexactRaw = `${JSON.stringify(inexactLedger, null, 2)}\n`;
    await writeFile(inexact.ledgerFile, inexactRaw, "utf8");
    await expect(readFollowupTriageLedgerStrict(inexact.ledgerFile)).rejects.toThrow("hash chain");
    expect(await readFile(inexact.ledgerFile, "utf8")).toBe(inexactRaw);
  });
});
