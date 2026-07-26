import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  authorizeFollowupTriage,
  confirmFollowupTriage,
  FollowupTriageAuthorizationLockError,
  FollowupTriageAuthorizationStoreError,
  readFollowupTriageLedgerStrict
} from "../src/personal-followup-triage-authorization-store.js";
import { readFollowupsStrict, writeFollowups, type PersistedFollowup } from "../src/personal-followups-store.js";

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

async function preparedFixture(
  action: "dismiss" | "snooze" | "retain" | "draft-digest",
  snoozeAt?: string
) {
  const f = await fixture();
  const authorization = await authorizeFollowupTriage({
    action,
    followupsFile: f.followupsFile,
    ids: ["fu_a"],
    ledgerFile: f.ledgerFile,
    now: () => BASE,
    ...(snoozeAt ? { snoozeAt } : {})
  });
  await expect(confirmFollowupTriage({
    failpoint: (point) => { if (point === "after-prepared") throw new Error("crash"); },
    followupsFile: f.followupsFile,
    ledgerFile: f.ledgerFile,
    now: () => new Date(BASE.getTime() + 60_000),
    token: authorization.confirmToken
  })).rejects.toThrow("crash");
  const ledger = JSON.parse(await readFile(f.ledgerFile, "utf8")) as {
    events: Record<string, unknown>[];
    schemaVersion: string;
  };
  return { ...f, ledger };
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

function rehashResult(result: Record<string, unknown>): void {
  const { resultDigest: _resultDigest, ...withoutDigest } = result;
  result.resultDigest = createHash("sha256").update(canonical(withoutDigest), "utf8").digest("hex");
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
    const tokenSecret = authorization.confirmToken.slice(`ft1_${authorization.operationId}_`.length);
    expect(raw).not.toContain(tokenSecret);
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

  it("applies dismiss once and replays the exact immutable receipt without writes after expiry", async () => {
    const f = await fixture([followup("fu_a", { summary: "private receipt text" })]);
    const authorization = await authorizeFollowupTriage({
      action: "dismiss",
      followupsFile: f.followupsFile,
      ids: ["fu_a"],
      ledgerFile: f.ledgerFile,
      now: () => BASE
    });
    const result = await confirmFollowupTriage({
      followupsFile: f.followupsFile,
      ledgerFile: f.ledgerFile,
      now: () => new Date(BASE.getTime() + 60_000),
      token: authorization.confirmToken
    });
    expect(result).toMatchObject({
      action: "dismiss",
      ids: ["fu_a"],
      operationId: authorization.operationId,
      outcome: "applied",
      status: "applied"
    });
    expect(result.resultDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect((await readFollowupsStrict(f.followupsFile))[0]).toMatchObject({
      cancelReason: "backlog-triage-dismissed",
      status: "cancelled"
    });
    const ledgerAfter = await readFile(f.ledgerFile, "utf8");
    const sourceAfter = await readFile(f.followupsFile, "utf8");
    expect(ledgerAfter).not.toContain("private receipt text");
    expect(JSON.stringify(result)).not.toContain("private receipt text");
    expect((await readFollowupTriageLedgerStrict(f.ledgerFile)).events.map((event) => event.type))
      .toEqual(["previewed", "prepared", "terminal"]);

    const replay = await confirmFollowupTriage({
      followupsFile: f.followupsFile,
      ledgerFile: f.ledgerFile,
      now: () => new Date(BASE.getTime() + 86_400_000),
      token: authorization.confirmToken
    });
    expect(replay).toEqual(result);
    expect(await readFile(f.ledgerFile, "utf8")).toBe(ledgerAfter);
    expect(await readFile(f.followupsFile, "utf8")).toBe(sourceAfter);
  });

  it("rejects a correctly rehashed terminal whose result digest was altered", async () => {
    const f = await fixture();
    const authorization = await authorizeFollowupTriage({
      action: "retain",
      followupsFile: f.followupsFile,
      ids: ["fu_a"],
      ledgerFile: f.ledgerFile,
      now: () => BASE
    });
    await confirmFollowupTriage({
      followupsFile: f.followupsFile,
      ledgerFile: f.ledgerFile,
      now: () => new Date(BASE.getTime() + 60_000),
      token: authorization.confirmToken
    });
    const ledger = JSON.parse(await readFile(f.ledgerFile, "utf8")) as {
      events: Record<string, unknown>[];
      schemaVersion: string;
    };
    const terminal = ledger.events.at(-1)!;
    (terminal.result as Record<string, unknown>).resultDigest = "0".repeat(64);
    rehash(terminal);
    const raw = `${JSON.stringify(ledger, null, 2)}\n`;
    await writeFile(f.ledgerFile, raw, "utf8");
    await expect(readFollowupTriageLedgerStrict(f.ledgerFile)).rejects.toThrow();
    expect(await readFile(f.ledgerFile, "utf8")).toBe(raw);
  });

  it("rejects correctly rehashed terminal histories that the runtime cannot produce", async () => {
    const preparedDrift = await fixture();
    const preparedDriftAuthorization = await authorizeFollowupTriage({
      action: "dismiss",
      followupsFile: preparedDrift.followupsFile,
      ids: ["fu_a"],
      ledgerFile: preparedDrift.ledgerFile,
      now: () => BASE
    });
    await confirmFollowupTriage({
      followupsFile: preparedDrift.followupsFile,
      ledgerFile: preparedDrift.ledgerFile,
      now: () => new Date(BASE.getTime() + 60_000),
      token: preparedDriftAuthorization.confirmToken
    });
    const preparedDriftLedger = JSON.parse(await readFile(preparedDrift.ledgerFile, "utf8")) as {
      events: Record<string, unknown>[];
      schemaVersion: string;
    };
    const preparedDriftTerminal = preparedDriftLedger.events.at(-1)!;
    preparedDriftTerminal.status = "conflict";
    preparedDriftTerminal.outcome = "snapshot-drift";
    delete preparedDriftTerminal.preparedEventId;
    const preparedDriftResult = preparedDriftTerminal.result as Record<string, unknown>;
    preparedDriftResult.status = "conflict";
    preparedDriftResult.outcome = "snapshot-drift";
    preparedDriftResult.postSourceDigest = null;
    rehashResult(preparedDriftResult);
    rehash(preparedDriftTerminal);
    await writeFile(preparedDrift.ledgerFile, `${JSON.stringify(preparedDriftLedger, null, 2)}\n`, "utf8");
    await expect(readFollowupTriageLedgerStrict(preparedDrift.ledgerFile))
      .rejects.toThrow("event order");

    const expiredDrift = await fixture();
    const expiredDriftAuthorization = await authorizeFollowupTriage({
      action: "dismiss",
      followupsFile: expiredDrift.followupsFile,
      ids: ["fu_a"],
      ledgerFile: expiredDrift.ledgerFile,
      now: () => BASE
    });
    await writeFollowups(expiredDrift.followupsFile, [followup("fu_a", { summary: "drift" })]);
    await confirmFollowupTriage({
      followupsFile: expiredDrift.followupsFile,
      ledgerFile: expiredDrift.ledgerFile,
      now: () => new Date(BASE.getTime() + 60_000),
      token: expiredDriftAuthorization.confirmToken
    });
    const expiredDriftLedger = JSON.parse(await readFile(expiredDrift.ledgerFile, "utf8")) as {
      events: Record<string, unknown>[];
      schemaVersion: string;
    };
    const expiredDriftTerminal = expiredDriftLedger.events.at(-1)!;
    expiredDriftTerminal.recordedAt = new Date(BASE.getTime() + 16 * 60_000).toISOString();
    rehash(expiredDriftTerminal);
    await writeFile(expiredDrift.ledgerFile, `${JSON.stringify(expiredDriftLedger, null, 2)}\n`, "utf8");
    await expect(readFollowupTriageLedgerStrict(expiredDrift.ledgerFile))
      .rejects.toThrow("event order");

    const earlySnooze = await fixture();
    const earlySnoozeAuthorization = await authorizeFollowupTriage({
      action: "snooze",
      followupsFile: earlySnooze.followupsFile,
      ids: ["fu_a"],
      ledgerFile: earlySnooze.ledgerFile,
      now: () => BASE,
      snoozeAt: new Date(BASE.getTime() + 5 * 60_000).toISOString()
    });
    await confirmFollowupTriage({
      followupsFile: earlySnooze.followupsFile,
      ledgerFile: earlySnooze.ledgerFile,
      now: () => new Date(BASE.getTime() + 5 * 60_000),
      token: earlySnoozeAuthorization.confirmToken
    });
    const earlySnoozeLedger = JSON.parse(await readFile(earlySnooze.ledgerFile, "utf8")) as {
      events: Record<string, unknown>[];
      schemaVersion: string;
    };
    const earlySnoozeTerminal = earlySnoozeLedger.events.at(-1)!;
    earlySnoozeTerminal.recordedAt = new Date(BASE.getTime() + 60_000).toISOString();
    rehash(earlySnoozeTerminal);
    await writeFile(earlySnooze.ledgerFile, `${JSON.stringify(earlySnoozeLedger, null, 2)}\n`, "utf8");
    await expect(readFollowupTriageLedgerStrict(earlySnooze.ledgerFile))
      .rejects.toThrow("event order");

    const earlyPreparedSnooze = await fixture();
    const earlyPreparedAuthorization = await authorizeFollowupTriage({
      action: "snooze",
      followupsFile: earlyPreparedSnooze.followupsFile,
      ids: ["fu_a"],
      ledgerFile: earlyPreparedSnooze.ledgerFile,
      now: () => BASE,
      snoozeAt: new Date(BASE.getTime() + 5 * 60_000).toISOString()
    });
    await expect(confirmFollowupTriage({
      failpoint: (point) => { if (point === "after-prepared") throw new Error("crash"); },
      followupsFile: earlyPreparedSnooze.followupsFile,
      ledgerFile: earlyPreparedSnooze.ledgerFile,
      now: () => new Date(BASE.getTime() + 60_000),
      token: earlyPreparedAuthorization.confirmToken
    })).rejects.toThrow("crash");
    await confirmFollowupTriage({
      followupsFile: earlyPreparedSnooze.followupsFile,
      ledgerFile: earlyPreparedSnooze.ledgerFile,
      now: () => new Date(BASE.getTime() + 5 * 60_000),
      token: earlyPreparedAuthorization.confirmToken
    });
    const earlyPreparedLedger = JSON.parse(await readFile(earlyPreparedSnooze.ledgerFile, "utf8")) as {
      events: Record<string, unknown>[];
      schemaVersion: string;
    };
    const earlyPreparedTerminal = earlyPreparedLedger.events.at(-1)!;
    earlyPreparedTerminal.recordedAt = new Date(BASE.getTime() + 2 * 60_000).toISOString();
    rehash(earlyPreparedTerminal);
    await writeFile(
      earlyPreparedSnooze.ledgerFile,
      `${JSON.stringify(earlyPreparedLedger, null, 2)}\n`,
      "utf8"
    );
    await expect(readFollowupTriageLedgerStrict(earlyPreparedSnooze.ledgerFile))
      .rejects.toThrow("event order");
  });

  it("rejects correctly rehashed prepared histories that the runtime cannot produce", async () => {
    for (const action of ["retain", "draft-digest"] as const) {
      const unchanged = await preparedFixture(action);
      const prepared = unchanged.ledger.events.at(-1)!;
      prepared.postSourceDigest = "0".repeat(64);
      rehash(prepared);
      await writeFile(unchanged.ledgerFile, `${JSON.stringify(unchanged.ledger, null, 2)}\n`, "utf8");
      await expect(readFollowupTriageLedgerStrict(unchanged.ledgerFile))
        .rejects.toThrow("event order");
    }

    const changed = await preparedFixture("dismiss");
    const changedPrepared = changed.ledger.events.at(-1)!;
    changedPrepared.postSourceDigest = changedPrepared.preSourceDigest;
    rehash(changedPrepared);
    await writeFile(changed.ledgerFile, `${JSON.stringify(changed.ledger, null, 2)}\n`, "utf8");
    await expect(readFollowupTriageLedgerStrict(changed.ledgerFile))
      .rejects.toThrow("event order");

    const snoozeAt = new Date(BASE.getTime() + 5 * 60_000).toISOString();
    const lateSnooze = await preparedFixture("snooze", snoozeAt);
    const lateSnoozePrepared = lateSnooze.ledger.events.at(-1)!;
    lateSnoozePrepared.preparedAt = snoozeAt;
    lateSnoozePrepared.recordedAt = snoozeAt;
    rehash(lateSnoozePrepared);
    await writeFile(lateSnooze.ledgerFile, `${JSON.stringify(lateSnooze.ledger, null, 2)}\n`, "utf8");
    await expect(readFollowupTriageLedgerStrict(lateSnooze.ledgerFile))
      .rejects.toThrow("event order");
  });

  it("snoozes to the exact instant while retain and draft-digest preserve source bytes", async () => {
    const snooze = await fixture();
    const snoozeAuthorization = await authorizeFollowupTriage({
      action: "snooze",
      followupsFile: snooze.followupsFile,
      ids: ["fu_a"],
      ledgerFile: snooze.ledgerFile,
      now: () => BASE,
      snoozeAt: "2026-07-23T09:30:00+09:00"
    });
    await confirmFollowupTriage({
      followupsFile: snooze.followupsFile,
      ledgerFile: snooze.ledgerFile,
      now: () => new Date(BASE.getTime() + 60_000),
      token: snoozeAuthorization.confirmToken
    });
    expect((await readFollowupsStrict(snooze.followupsFile))[0]?.scheduledFor)
      .toBe("2026-07-23T00:30:00.000Z");

    for (const action of ["retain", "draft-digest"] as const) {
      const f = await fixture();
      const before = await readFile(f.followupsFile, "utf8");
      const authorization = await authorizeFollowupTriage({
        action,
        followupsFile: f.followupsFile,
        ids: ["fu_a"],
        ledgerFile: f.ledgerFile,
        now: () => BASE
      });
      const result = await confirmFollowupTriage({
        followupsFile: f.followupsFile,
        ledgerFile: f.ledgerFile,
        now: () => new Date(BASE.getTime() + 60_000),
        token: authorization.confirmToken
      });
      expect(result).toMatchObject({ action, outcome: "applied", status: "applied" });
      expect(await readFile(f.followupsFile, "utf8")).toBe(before);
    }
  });

  it("rejects forged and expired tokens and records source drift or elapsed snooze without source writes", async () => {
    const forged = await fixture();
    const forgedAuthorization = await authorizeFollowupTriage({
      action: "dismiss",
      followupsFile: forged.followupsFile,
      ids: ["fu_a"],
      ledgerFile: forged.ledgerFile,
      now: () => BASE
    });
    const sourceBefore = await readFile(forged.followupsFile, "utf8");
    const ledgerBefore = await readFile(forged.ledgerFile, "utf8");
    const last = forgedAuthorization.confirmToken.at(-1)!;
    const forgedToken = `${forgedAuthorization.confirmToken.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    await expect(confirmFollowupTriage({
      followupsFile: forged.followupsFile,
      ledgerFile: forged.ledgerFile,
      token: forgedToken
    })).rejects.toThrow("invalid");
    expect(await readFile(forged.followupsFile, "utf8")).toBe(sourceBefore);
    expect(await readFile(forged.ledgerFile, "utf8")).toBe(ledgerBefore);
    await expect(confirmFollowupTriage({
      followupsFile: forged.followupsFile,
      ledgerFile: forged.ledgerFile,
      now: () => new Date(BASE.getTime() + 16 * 60_000),
      token: forgedAuthorization.confirmToken
    })).rejects.toThrow("expired");

    const drift = await fixture();
    const driftAuthorization = await authorizeFollowupTriage({
      action: "dismiss",
      followupsFile: drift.followupsFile,
      ids: ["fu_a"],
      ledgerFile: drift.ledgerFile,
      now: () => BASE
    });
    await writeFollowups(drift.followupsFile, [followup("fu_a", { summary: "changed elsewhere" })]);
    const drifted = await readFile(drift.followupsFile, "utf8");
    const driftResult = await confirmFollowupTriage({
      followupsFile: drift.followupsFile,
      ledgerFile: drift.ledgerFile,
      now: () => new Date(BASE.getTime() + 60_000),
      token: driftAuthorization.confirmToken
    });
    expect(driftResult).toMatchObject({ outcome: "snapshot-drift", postSourceDigest: null, status: "conflict" });
    expect(await readFile(drift.followupsFile, "utf8")).toBe(drifted);

    const elapsed = await fixture();
    const elapsedAuthorization = await authorizeFollowupTriage({
      action: "snooze",
      followupsFile: elapsed.followupsFile,
      ids: ["fu_a"],
      ledgerFile: elapsed.ledgerFile,
      now: () => BASE,
      snoozeAt: new Date(BASE.getTime() + 5 * 60_000).toISOString()
    });
    const elapsedBefore = await readFile(elapsed.followupsFile, "utf8");
    const elapsedResult = await confirmFollowupTriage({
      followupsFile: elapsed.followupsFile,
      ledgerFile: elapsed.ledgerFile,
      now: () => new Date(BASE.getTime() + 5 * 60_000),
      token: elapsedAuthorization.confirmToken
    });
    expect(elapsedResult).toMatchObject({ outcome: "snooze-time-elapsed", status: "conflict" });
    expect(await readFile(elapsed.followupsFile, "utf8")).toBe(elapsedBefore);
  });

  it.each([
    ["before-prepared", "applied"],
    ["after-prepared", "applied"],
    ["before-followups", "applied"],
    ["after-followups", "recovered-post-image"],
    ["before-terminal", "recovered-post-image"],
    ["after-terminal", "applied"]
  ] as const)("recovers exactly after %s without duplicate mutation", async (failurePoint, expectedOutcome) => {
    const f = await fixture();
    const authorization = await authorizeFollowupTriage({
      action: "dismiss",
      followupsFile: f.followupsFile,
      ids: ["fu_a"],
      ledgerFile: f.ledgerFile,
      now: () => BASE
    });
    await expect(confirmFollowupTriage({
      failpoint: (point) => { if (point === failurePoint) throw new Error(failurePoint); },
      followupsFile: f.followupsFile,
      ledgerFile: f.ledgerFile,
      now: () => new Date(BASE.getTime() + 60_000),
      token: authorization.confirmToken
    })).rejects.toThrow(failurePoint);

    const recovered = await confirmFollowupTriage({
      followupsFile: f.followupsFile,
      ledgerFile: f.ledgerFile,
      now: () => new Date(BASE.getTime() + 2 * 60_000),
      token: authorization.confirmToken
    });
    expect(recovered.outcome).toBe(expectedOutcome);
    expect((await readFollowupsStrict(f.followupsFile))).toHaveLength(1);
    expect((await readFollowupsStrict(f.followupsFile))[0]?.status).toBe("cancelled");
    const events = (await readFollowupTriageLedgerStrict(f.ledgerFile)).events;
    expect(events.filter((event) => event.type === "prepared")).toHaveLength(1);
    expect(events.filter((event) => event.type === "terminal")).toHaveLength(1);
  });

  it("records indeterminate conflict after preparation when source matches neither pre nor post image", async () => {
    const f = await fixture();
    const authorization = await authorizeFollowupTriage({
      action: "dismiss",
      followupsFile: f.followupsFile,
      ids: ["fu_a"],
      ledgerFile: f.ledgerFile,
      now: () => BASE
    });
    await expect(confirmFollowupTriage({
      failpoint: (point) => { if (point === "after-prepared") throw new Error("crash"); },
      followupsFile: f.followupsFile,
      ledgerFile: f.ledgerFile,
      now: () => new Date(BASE.getTime() + 60_000),
      token: authorization.confirmToken
    })).rejects.toThrow("crash");
    await writeFollowups(f.followupsFile, [followup("fu_a", { summary: "third image" })]);
    const thirdImage = await readFile(f.followupsFile, "utf8");
    const result = await confirmFollowupTriage({
      followupsFile: f.followupsFile,
      ledgerFile: f.ledgerFile,
      now: () => new Date(BASE.getTime() + 2 * 60_000),
      token: authorization.confirmToken
    });
    expect(result).toMatchObject({ outcome: "indeterminate-after-preparation", status: "conflict" });
    expect(await readFile(f.followupsFile, "utf8")).toBe(thirdImage);
  });

  it("does not apply a prepared snooze after its target instant has elapsed", async () => {
    const f = await fixture();
    const snoozeAt = new Date(BASE.getTime() + 5 * 60_000).toISOString();
    const authorization = await authorizeFollowupTriage({
      action: "snooze",
      followupsFile: f.followupsFile,
      ids: ["fu_a"],
      ledgerFile: f.ledgerFile,
      now: () => BASE,
      snoozeAt
    });
    const before = await readFile(f.followupsFile, "utf8");
    await expect(confirmFollowupTriage({
      failpoint: (point) => { if (point === "after-prepared") throw new Error("crash"); },
      followupsFile: f.followupsFile,
      ledgerFile: f.ledgerFile,
      now: () => new Date(BASE.getTime() + 60_000),
      token: authorization.confirmToken
    })).rejects.toThrow("crash");
    const result = await confirmFollowupTriage({
      followupsFile: f.followupsFile,
      ledgerFile: f.ledgerFile,
      now: () => new Date(BASE.getTime() + 5 * 60_000),
      token: authorization.confirmToken
    });
    expect(result).toMatchObject({ outcome: "snooze-time-elapsed", status: "conflict" });
    expect(await readFile(f.followupsFile, "utf8")).toBe(before);
  });

  it("applies one concurrent confirm, fails the contender closed, and replays one terminal receipt", async () => {
    const f = await fixture();
    const authorization = await authorizeFollowupTriage({
      action: "dismiss",
      followupsFile: f.followupsFile,
      ids: ["fu_a"],
      ledgerFile: f.ledgerFile,
      now: () => BASE
    });
    const options = {
      followupsFile: f.followupsFile,
      ledgerFile: f.ledgerFile,
      now: () => new Date(BASE.getTime() + 60_000),
      token: authorization.confirmToken
    };
    const concurrent = await Promise.allSettled([
      confirmFollowupTriage(options),
      confirmFollowupTriage(options)
    ]);
    const fulfilled = concurrent.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof confirmFollowupTriage>>> =>
      result.status === "fulfilled"
    );
    const rejected = concurrent.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled?.value).toMatchObject({ outcome: "applied", status: "applied" });
    expect(rejected?.reason).toBeInstanceOf(FollowupTriageAuthorizationLockError);
    expect(await confirmFollowupTriage(options)).toEqual(fulfilled?.value);
    expect((await readFollowupTriageLedgerStrict(f.ledgerFile)).events.map((event) => event.type))
      .toEqual(["previewed", "prepared", "terminal"]);
    expect((await readFollowupsStrict(f.followupsFile))[0]?.status).toBe("cancelled");
  });
});
