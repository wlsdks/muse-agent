import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPersonalThread,
  linkArtifact,
  openPreparedContinuityPack,
  readAttunementState,
  recordContinuityOutcome
} from "./index.js";
import type { ArtifactLink } from "./index.js";
import { createOrganicContinuityWriteAuthority } from "./evidence-provenance.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "muse-continuity-provenance-"));
  const file = join(dir, "attunement.json");
  const thread = await createPersonalThread(file, { kind: "life", title: "Resume trip plan" });
  await linkArtifact(file, {
    artifactId: "trip.md",
    artifactType: "note",
    role: "context",
    threadId: thread.id
  }, { validateArtifact: async (input) => input });
  const resolve = async (link: ArtifactLink) => ({
    ...link,
    title: "Trip notes"
  });
  return { file, resolve, thread };
}

describe("Continuity evidence provenance", () => {
  it("classifies each delivery/outcome write once and cannot upgrade it by replay", async () => {
    const { file, resolve, thread } = await fixture();
    const organic = createOrganicContinuityWriteAuthority();

    const general = await openPreparedContinuityPack(file, thread.id, resolve);
    await recordContinuityOutcome(file, general.delivery.id, "ignored");
    const controlled = await openPreparedContinuityPack(file, thread.id, resolve, { evidenceClass: "controlled" });
    await recordContinuityOutcome(file, controlled.delivery.id, "adjusted", { evidenceClass: "controlled" });
    const production = await openPreparedContinuityPack(file, thread.id, resolve, { evidenceAuthority: organic });
    await recordContinuityOutcome(file, production.delivery.id, "used", { evidenceAuthority: organic });
    await recordContinuityOutcome(file, production.delivery.id, "used", { evidenceClass: "controlled" });
    await openPreparedContinuityPack(file, thread.id, resolve, {
      evidenceAuthority: JSON.parse(JSON.stringify(organic)),
      evidenceClass: "organic"
    } as never);

    const state = await readAttunementState(file);
    expect(state.schemaVersion).toBe(4);
    expect(state.deliveries.map((delivery) => ({
      delivery: delivery.evidenceClass,
      outcome: delivery.outcome?.evidenceClass
    }))).toEqual([
      { delivery: "unclassified", outcome: "unclassified" },
      { delivery: "controlled", outcome: "controlled" },
      { delivery: "organic", outcome: "organic" },
      { delivery: "unclassified", outcome: undefined }
    ]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ schemaVersion: 4 });
  });

  it("normalizes schema 2 evidence in memory without rewriting bytes, then migrates on mutation", async () => {
    const { file, resolve, thread } = await fixture();
    const opened = await openPreparedContinuityPack(file, thread.id, resolve, { evidenceClass: "controlled" });
    await recordContinuityOutcome(file, opened.delivery.id, "ignored", { evidenceClass: "controlled" });
    const current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const deliveries = current.deliveries as Array<Record<string, unknown>>;
    const delivery = deliveries[0]!;
    const outcome = delivery.outcome as Record<string, unknown>;
    const threadRecord = (current.threads as Array<Record<string, unknown>>)[0]!;
    const link = (threadRecord.links as Array<Record<string, unknown>>)[0]!;
    const linkedAt = link.linkedAt as string;
    Object.assign(link, { artifactId: "task_legacy", artifactType: "task", role: "next-step" });
    Object.assign(delivery, {
      evidenceRefs: [{ artifactId: "task_legacy", artifactType: "task", providerId: "local", role: "next-step" }],
      interactionAnchor: {
        artifactId: "task_legacy",
        linkedAt,
        observedAt: delivery.openedAt,
        observedStatus: "open",
        openStateFingerprint: "a".repeat(64),
        providerId: "local",
        role: "next-step"
      }
    });
    delete delivery.evidenceClass;
    delete outcome.evidenceClass;
    // `openedAt` comes from the real clock inside openPreparedContinuityPack, and
    // validateStateRelations requires completedAt > openedAt. Derive it rather
    // than hardcoding an instant: a literal only satisfies that ordering until
    // the wall clock passes it (the original "2026-07-18T23:59:59.000Z" held for
    // the six minutes between the commit and midnight, then failed forever).
    const completedAt = new Date(Date.parse(delivery.openedAt as string) + 1_000).toISOString();
    current.interactionReceipts = [{
      artifactId: "task_legacy",
      completedAt,
      deliveryId: delivery.id,
      doneStateFingerprint: "b".repeat(64),
      eventId: "event_legacy",
      id: "receipt_legacy",
      linkedAt,
      openStateFingerprint: "a".repeat(64),
      providerId: "local",
      recordedAt: completedAt,
      role: "next-step",
      runId: delivery.runId,
      threadId: threadRecord.id,
      transition: "open-to-done"
    }];
    current.schemaVersion = 2;
    const legacyBytes = `${JSON.stringify(current)}\n`;
    await writeFile(file, legacyBytes, { mode: 0o600 });

    const normalized = await readAttunementState(file);
    expect(await readFile(file, "utf8")).toBe(legacyBytes);
    expect(normalized.schemaVersion).toBe(4);
    expect(normalized.deliveries[0]).toMatchObject({
      evidenceClass: "unclassified",
      id: delivery.id,
      outcome: { evidenceClass: "unclassified", recordedAt: outcome.recordedAt }
    });
    expect(normalized.interactionReceipts[0]).toMatchObject({
      evidenceClass: "unclassified",
      eventId: "event_legacy",
      id: "receipt_legacy"
    });

    await createPersonalThread(file, { kind: "work", title: "Migration trigger" });
    const migrated = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(migrated).toMatchObject({ schemaVersion: 4 });
    expect((migrated.deliveries as Array<Record<string, unknown>>)[0]).toMatchObject({
      evidenceClass: "unclassified",
      id: delivery.id,
      outcome: { evidenceClass: "unclassified", recordedAt: outcome.recordedAt }
    });
    expect((migrated.interactionReceipts as Array<Record<string, unknown>>)[0]).toMatchObject({
      evidenceClass: "unclassified",
      eventId: "event_legacy",
      id: "receipt_legacy"
    });
  });

  it("normalizes schema 1 delivery and outcome provenance without rewriting bytes", async () => {
    const { file, resolve, thread } = await fixture();
    const opened = await openPreparedContinuityPack(file, thread.id, resolve, { evidenceClass: "controlled" });
    await recordContinuityOutcome(file, opened.delivery.id, "adjusted", { evidenceClass: "controlled" });
    const legacy = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const delivery = (legacy.deliveries as Array<Record<string, unknown>>)[0]!;
    const outcome = delivery.outcome as Record<string, unknown>;
    delete delivery.evidenceClass;
    delete outcome.evidenceClass;
    delete legacy.interactionReceipts;
    legacy.schemaVersion = 1;
    const legacyBytes = `${JSON.stringify(legacy)}\n`;
    await writeFile(file, legacyBytes, { mode: 0o600 });

    const normalized = await readAttunementState(file);
    expect(await readFile(file, "utf8")).toBe(legacyBytes);
    expect(normalized.deliveries[0]).toMatchObject({
      evidenceClass: "unclassified",
      id: delivery.id,
      outcome: { evidenceClass: "unclassified", recordedAt: outcome.recordedAt }
    });

    await createPersonalThread(file, { kind: "work", title: "Schema 1 migration trigger" });
    const migrated = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(migrated).toMatchObject({ schemaVersion: 4 });
    expect((migrated.deliveries as Array<Record<string, unknown>>)[0]).toMatchObject({
      evidenceClass: "unclassified",
      id: delivery.id,
      outcome: { evidenceClass: "unclassified", recordedAt: outcome.recordedAt }
    });
  });

  it("serializes conflicting concurrent provenance and never promotes the winner on replay", async () => {
    const { file, resolve, thread } = await fixture();
    const opened = await openPreparedContinuityPack(file, thread.id, resolve, { evidenceClass: "controlled" });
    const organic = createOrganicContinuityWriteAuthority();
    const results = await Promise.all([
      recordContinuityOutcome(file, opened.delivery.id, "used", { evidenceAuthority: organic }),
      recordContinuityOutcome(file, opened.delivery.id, "used", { evidenceClass: "controlled" })
    ]);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    const winner = (await readAttunementState(file)).deliveries[0]!.outcome!.evidenceClass;
    expect(["controlled", "organic"]).toContain(winner);

    await recordContinuityOutcome(file, opened.delivery.id, "used", winner === "organic"
      ? { evidenceClass: "controlled" }
      : { evidenceAuthority: organic });
    expect((await readAttunementState(file)).deliveries[0]!.outcome!.evidenceClass).toBe(winner);
  });
});
