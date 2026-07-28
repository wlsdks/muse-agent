import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPersonalThread,
  openContinuityDelivery,
  readAttunementState,
  recordContinuityOutcome,
  type ActiveAttunementPolicyWriteGate
} from "./index.js";

let directory: string | undefined;
const allow: ActiveAttunementPolicyWriteGate = {
  run: (operation) => operation()
};

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("Continuity explicit owner outcome note", () => {
  it("persists one bounded exact note and forbids adding, removing, or overwriting it", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-outcome-note-"));
    const file = join(directory, "attunement.json");
    const thread = await createPersonalThread(file, {
      kind: "life",
      title: "Morning routine"
    });
    const delivery = await openContinuityDelivery(file, {
      evidenceRefs: [],
      expectedPolicyVersion: thread.policy.version,
      threadId: thread.id
    });
    const note = "The shorter summary helped me restart.";
    const first = await recordContinuityOutcome(
      file,
      delivery.id,
      "used",
      allow,
      { ownerNote: note }
    );
    expect(first).toMatchObject({
      applied: true,
      delivery: {
        outcome: {
          outcome: "used",
          ownerNote: note
        }
      }
    });
    const after = await readFile(file);

    await expect(recordContinuityOutcome(file, delivery.id, "used", allow))
      .rejects.toThrow(/owner note cannot be added, removed, or overwritten/u);
    await expect(recordContinuityOutcome(
      file,
      delivery.id,
      "used",
      allow,
      { ownerNote: "Different note" }
    )).rejects.toThrow(/owner note cannot be added, removed, or overwritten/u);
    expect(await readFile(file)).toEqual(after);
    expect((await readAttunementState(file)).deliveries[0]!.outcome?.ownerNote)
      .toBe(note);
  });

  it("rejects invalid optional notes before any policy mutation", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-outcome-note-invalid-"));
    const file = join(directory, "attunement.json");
    const thread = await createPersonalThread(file, {
      kind: "work",
      title: "Release"
    });
    const delivery = await openContinuityDelivery(file, {
      evidenceRefs: [],
      expectedPolicyVersion: thread.policy.version,
      threadId: thread.id
    });
    const before = await readFile(file);

    for (const ownerNote of ["", " padded ", "line\nbreak", "x".repeat(501)]) {
      await expect(recordContinuityOutcome(
        file,
        delivery.id,
        "adjusted",
        allow,
        { ownerNote }
      )).rejects.toThrow(/owner note must be 1-500/u);
    }
    expect(await readFile(file)).toEqual(before);
  });
});
