import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AttunementStoreError,
  createPersonalThread,
  linkArtifact,
  openContinuityDelivery,
  readAttunementState,
  recordContinuityOutcome,
  resetThreadPolicy,
  undoThreadReset,
  unlinkArtifact
} from "./index.js";
import type { AttunementState, LinkArtifactOptions } from "./index.js";

function stateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-attunement-")), "attunement.json");
}

function deterministicOptions(): LinkArtifactOptions {
  let index = 0;
  return {
    idFactory: () => `id-${(++index).toString()}`,
    now: () => new Date("2026-07-14T00:00:00.000Z"),
    validateArtifact: async ({ artifactId, artifactType, providerId }) => ({ artifactId, artifactType, providerId })
  };
}

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function cloneState(state: AttunementState): Mutable<AttunementState> {
  return JSON.parse(JSON.stringify(state)) as Mutable<AttunementState>;
}

describe("Personal Continuity store", () => {
  it("creates equal life/work threads without a default and writes owner-only state", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const life = await createPersonalThread(file, { kind: "life", title: "Plan a quiet birthday" }, options);
    const work = await createPersonalThread(file, { kind: "work", title: "Ship the continuity slice" }, options);

    expect(life.kind).toBe("life");
    expect(work.kind).toBe("work");
    expect((statSync(file).mode & 0o777)).toBe(0o600);
    expect((await readAttunementState(file)).threads.map((thread) => thread.kind)).toEqual(["life", "work"]);
  });

  it("reads schema v4 byte-stably, migrates on explicit mutation, and rejects v4 calendar laundering", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const thread = await createPersonalThread(file, { kind: "life", title: "Prepare for the dentist" }, options);
    const current = readFileSync(file, "utf8");
    const legacy = current.replace('"schemaVersion": 5', '"schemaVersion": 4');
    writeFileSync(file, legacy, "utf8");

    expect((await readAttunementState(file)).schemaVersion).toBe(5);
    expect(readFileSync(file, "utf8")).toBe(legacy);

    await linkArtifact(file, {
      artifactId: "cev1_WyJldmVudCIsIjIwMjYtMDctMjJUMDk6MDA6MDAuMDAwWiJd",
      artifactType: "calendar-event",
      providerId: "calendar:local",
      role: "context",
      threadId: thread.id
    }, options);
    const migrated = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion: number };
    expect(migrated.schemaVersion).toBe(5);

    const forgedLegacy = readFileSync(file, "utf8").replace('"schemaVersion": 5', '"schemaVersion": 4');
    writeFileSync(file, forgedLegacy, "utf8");
    await expect(readAttunementState(file)).rejects.toThrow("attunement store is invalid");
    expect(readFileSync(file, "utf8")).toBe(forgedLegacy);
  });

  it("accepts only explicit local links and never guesses between next-step tasks", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const thread = await createPersonalThread(file, { kind: "work", title: "Prepare the launch" }, options);
    const first = await linkArtifact(file, {
      artifactId: "task_full-id-1",
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, options);
    const replay = await linkArtifact(file, {
      artifactId: "task_full-id-1",
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, options);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    await expect(linkArtifact(file, {
      artifactId: "task_full-id-2",
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, options)).rejects.toThrow("already has a next-step");
    await expect(linkArtifact(file, {
      artifactId: "note.md",
      artifactType: "note",
      role: "next-step",
      threadId: thread.id
    }, options)).rejects.toThrow("only a local task");

    expect(await unlinkArtifact(file, { artifactId: "task_full-id-1", artifactType: "task", threadId: thread.id })).toBe(true);
    expect(await unlinkArtifact(file, { artifactId: "task_full-id-1", artifactType: "task", threadId: thread.id })).toBe(false);
  });

  it("unlinks a calendar occurrence from only the explicitly named provider", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const thread = await createPersonalThread(file, { kind: "life", title: "Shared occurrence ids" }, options);
    const reference = "cev1_WyJzYW1lIiwiMjAyNi0wNy0yMlQwOTowMDowMC4wMDBaIl0";
    for (const providerId of ["calendar:work", "calendar:life"] as const) {
      await linkArtifact(file, {
        artifactId: reference,
        artifactType: "calendar-event",
        providerId,
        role: "context",
        threadId: thread.id
      }, { ...options, validateArtifact: async ({ artifactId, artifactType, providerId }) => ({ artifactId, artifactType, providerId }) });
    }

    expect(await unlinkArtifact(file, {
      artifactId: reference,
      artifactType: "calendar-event",
      providerId: "calendar:work",
      threadId: thread.id
    })).toBe(true);
    expect((await readAttunementState(file)).threads[0]?.links).toMatchObject([
      { artifactId: reference, artifactType: "calendar-event", providerId: "calendar:life" }
    ]);
  });

  it("requires an exact validator, stores its canonical ID, and rejects unsafe note paths at the public mutation boundary", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const thread = await createPersonalThread(file, { kind: "life", title: "Keep the move grounded" }, options);
    const input = { artifactId: "short-id", artifactType: "task" as const, role: "context" as const, threadId: thread.id };

    await expect(linkArtifact(file, input, undefined as never)).rejects.toThrow("requires an exact artifact validator");
    const linked = await linkArtifact(file, input, {
      ...options,
      validateArtifact: async ({ artifactType }) => ({ artifactId: "task_full-canonical-id", artifactType, providerId: "local" })
    });
    expect(linked.link.artifactId).toBe("task_full-canonical-id");

    await expect(linkArtifact(file, {
      artifactId: "../outside.md",
      artifactType: "note",
      role: "context",
      threadId: thread.id
    }, options)).rejects.toThrow("unsafe relative note id");
    await expect(linkArtifact(file, {
      artifactId: "inside.md",
      artifactType: "note",
      role: "context",
      threadId: thread.id
    }, {
      ...options,
      validateArtifact: async ({ artifactType }) => ({ artifactId: "/outside.md", artifactType, providerId: "local" })
    })).rejects.toThrow("unsafe relative note id");
    await expect(linkArtifact(file, {
      artifactId: "task_type-check",
      artifactType: "task",
      role: "context",
      threadId: thread.id
    }, {
      ...options,
      validateArtifact: async () => ({ artifactId: "note.md", artifactType: "note", providerId: "local" })
    })).rejects.toThrow("changed the artifact type");
  });

  it("records one canonical outcome atomically, replays the same receipt, and refuses overwrite", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const thread = await createPersonalThread(file, { kind: "life", title: "Get ready for the move" }, options);
    await linkArtifact(file, { artifactId: "task_pack-boxes", artifactType: "task", role: "next-step", threadId: thread.id }, options);
    const delivery = await openContinuityDelivery(file, {
      evidenceRefs: [{ artifactId: "task_pack-boxes", artifactType: "task", providerId: "local", role: "next-step" }],
      expectedPolicyVersion: 0,
      threadId: thread.id
    }, options);

    const applied = await recordContinuityOutcome(file, delivery.id, "ignored", options);
    const replay = await recordContinuityOutcome(file, delivery.id, "ignored", options);
    expect(applied.applied).toBe(true);
    expect(applied.policy).toMatchObject({ detail: "compact", nextStep: "direct", suppression: "acknowledge-previous", version: 1 });
    expect(replay).toEqual({ applied: false, delivery: applied.delivery, policy: applied.policy });
    await expect(recordContinuityOutcome(file, delivery.id, "used", options)).rejects.toThrow("cannot be overwritten");
  });

  it("uses immutable reset/undo receipts, monotonically versions an undo, and rejects stale undo", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const thread = await createPersonalThread(file, { kind: "work", title: "Finish proposal" }, options);
    await linkArtifact(file, { artifactId: "task_proposal", artifactType: "task", role: "next-step", threadId: thread.id }, options);
    const delivery = await openContinuityDelivery(file, {
      evidenceRefs: [{ artifactId: "task_proposal", artifactType: "task", providerId: "local", role: "next-step" }],
      expectedPolicyVersion: 0,
      threadId: thread.id
    }, options);
    await recordContinuityOutcome(file, delivery.id, "used", options); // policy v1
    const reset = await resetThreadPolicy(file, thread.id, options); // policy v2
    expect(reset.alreadyBaseline).toBe(false);
    expect(reset.receipt?.basePolicyVersion).toBe(1);
    expect(reset.receipt?.resetPolicyVersion).toBe(2);

    const undone = await undoThreadReset(file, thread.id, reset.receipt!.id, options); // policy v3
    expect(undone.applied).toBe(true);
    expect(undone.receipt.undoPolicyVersion).toBe(3);
    expect(undone.thread.policy).toMatchObject({ detail: "compact", version: 3 });
    expect(await undoThreadReset(file, thread.id, reset.receipt!.id, options)).toEqual({ applied: false, receipt: undone.receipt, thread: undone.thread });

    const secondReset = await resetThreadPolicy(file, thread.id, options); // policy v4
    const afterResetDelivery = await openContinuityDelivery(file, {
      evidenceRefs: [{ artifactId: "task_proposal", artifactType: "task", providerId: "local", role: "next-step" }],
      expectedPolicyVersion: 4,
      threadId: thread.id
    }, options);
    await recordContinuityOutcome(file, afterResetDelivery.id, "adjusted", options); // policy v5
    await expect(undoThreadReset(file, thread.id, secondReset.receipt!.id, options)).rejects.toThrow("stale reset");
  });

  it("fails closed rather than replacing an invalid local store", async () => {
    const file = stateFile();
    writeFileSync(file, "{ definitely-not-json", "utf8");
    await expect(readAttunementState(file)).rejects.toBeInstanceOf(AttunementStoreError);
    await expect(createPersonalThread(file, { kind: "life", title: "Do not overwrite" })).rejects.toBeInstanceOf(AttunementStoreError);
  });

  it("fails closed on relationally invalid persisted state", async () => {
    const cases: readonly [string, (state: Mutable<AttunementState>, threadId: string) => void][] = [
      ["a link assigned to another thread", (state, threadId) => {
        state.threads[0]!.links.push({ artifactId: "note.md", artifactType: "note", linkedAt: "2026-07-14T00:00:00.000Z", linkedBy: "user", providerId: "local", role: "context", threadId: `${threadId}-other` });
      }],
      ["duplicate thread ids", (state) => {
        state.threads.push(cloneState(state).threads[0]!);
      }],
      ["two next steps", (state, threadId) => {
        state.threads[0]!.links.push({ artifactId: "task_one", artifactType: "task", linkedAt: "2026-07-14T00:00:00.000Z", linkedBy: "user", providerId: "local", role: "next-step", threadId });
        state.threads[0]!.links.push({ artifactId: "task_two", artifactType: "task", linkedAt: "2026-07-14T00:00:00.000Z", linkedBy: "user", providerId: "local", role: "next-step", threadId });
      }],
      ["delivery referencing no thread", (state) => {
        state.deliveries.push({ evidenceClass: "unclassified", evidenceRefs: [], id: "delivery_missing", openedAt: "2026-07-14T00:00:00.000Z", policyVersion: 0, threadId: "thread_missing" });
      }],
      ["undo receipt referencing no reset", (state, threadId) => {
        state.undoResetReceipts.push({ id: "undo_missing", previousPolicyVersion: 1, resetId: "reset_missing", restoredPolicy: { detail: "standard", nextStep: "direct", suppression: "none", version: 2 }, threadId, undoneAt: "2026-07-14T00:00:00.000Z", undoPolicyVersion: 2 });
      }],
      ["a non-monotonic next policy version", (state) => {
        state.nextPolicyVersion = 0;
      }]
    ];

    for (const [label, corrupt] of cases) {
      const file = stateFile();
      const thread = await createPersonalThread(file, { kind: "work", title: `Reject ${label}` });
      const invalid = cloneState(await readAttunementState(file));
      corrupt(invalid, thread.id);
      writeFileSync(file, JSON.stringify(invalid), "utf8");
      await expect(readAttunementState(file), label).rejects.toBeInstanceOf(AttunementStoreError);
    }
  });
});

describe("Personal Continuity store — external MCP resource sources", () => {
  const mcpValidator: LinkArtifactOptions["validateArtifact"] = async ({ artifactId, artifactType, providerId }) => ({
    artifactId: artifactType === "resource" ? "facebook/react/issues/1" : artifactId,
    artifactType,
    providerId
  });

  it("links a resource behind an mcp:<server> provider and reloads it unchanged", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const thread = await createPersonalThread(file, { kind: "work", title: "Ship the adapter" }, options);
    const linked = await linkArtifact(file, {
      artifactId: "facebook/react/issues/1",
      artifactType: "resource",
      providerId: "mcp:github",
      role: "context",
      threadId: thread.id
    }, { ...options, validateArtifact: mcpValidator });

    expect(linked.created).toBe(true);
    expect(linked.link.providerId).toBe("mcp:github");
    expect(linked.link.artifactType).toBe("resource");

    // The persisted mcp file parses back with the resource link intact — proof
    // an mcp:-provider state file loads, not only a local-only one.
    const reloaded = await readAttunementState(file);
    expect(reloaded.threads[0]!.links[0]).toMatchObject({ artifactId: "facebook/react/issues/1", providerId: "mcp:github", artifactType: "resource" });
  });

  it("keeps parsing a legacy local-only state file", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const thread = await createPersonalThread(file, { kind: "life", title: "Legacy local thread" }, options);
    await linkArtifact(file, { artifactId: "task_legacy", artifactType: "task", role: "next-step", threadId: thread.id }, options);
    // A pre-existing state file only ever held providerId "local" — it must load byte-for-byte unchanged.
    const reloaded = await readAttunementState(file);
    expect(reloaded.threads[0]!.links[0]!.providerId).toBe("local");
  });

  it("rejects a resource whose role is next-step (an external artifact is context-only)", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const thread = await createPersonalThread(file, { kind: "work", title: "Resource cannot be next-step" }, options);
    await expect(linkArtifact(file, {
      artifactId: "facebook/react/issues/1",
      artifactType: "resource",
      providerId: "mcp:github",
      role: "next-step",
      threadId: thread.id
    }, { ...options, validateArtifact: mcpValidator })).rejects.toThrow("only a local task can be a next-step");
  });

  it("stores one syntactically coherent calendar provider and keeps it context-only", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const thread = await createPersonalThread(file, { kind: "life", title: "Dentist visit" }, options);
    const linked = await linkArtifact(file, {
      artifactId: "cev1_WyJldmVudCIsIjIwMjYtMDctMjJUMDk6MDA6MDAuMDAwWiJd",
      artifactType: "calendar-event",
      providerId: "calendar:gcal",
      role: "context",
      threadId: thread.id
    }, options);
    expect(linked.link.providerId).toBe("calendar:gcal");
    expect((await readAttunementState(file)).threads[0]?.links[0]).toEqual(linked.link);
    await expect(linkArtifact(file, {
      ...linked.link,
      role: "next-step"
    }, options)).rejects.toThrow("only a local task can be a next-step");
  });

  it("fails closed on an incoherent provider/type at the link boundary", async () => {
    const file = stateFile();
    const options = deterministicOptions();
    const thread = await createPersonalThread(file, { kind: "work", title: "Coherence gate" }, options);
    // resource with a local provider
    await expect(linkArtifact(file, {
      artifactId: "x", artifactType: "resource", providerId: "local", role: "context", threadId: thread.id
    }, { ...options, validateArtifact: mcpValidator })).rejects.toThrow("does not match a resource");
    // task with an mcp: provider
    await expect(linkArtifact(file, {
      artifactId: "task_x", artifactType: "task", providerId: "mcp:github", role: "context", threadId: thread.id
    }, { ...options, validateArtifact: mcpValidator })).rejects.toThrow("does not match a task");
    await expect(linkArtifact(file, {
      artifactId: "event", artifactType: "calendar-event", providerId: "local", role: "context", threadId: thread.id
    }, options)).rejects.toThrow("does not match a calendar-event");
    await expect(linkArtifact(file, {
      artifactId: "event", artifactType: "calendar-event", providerId: "calendar:calendar:gcal", role: "context", threadId: thread.id
    }, options)).rejects.toThrow("does not match a calendar-event");
    // a validator that swaps to an incoherent provider is caught after validation
    await expect(linkArtifact(file, {
      artifactId: "facebook/react/issues/1", artifactType: "resource", providerId: "mcp:github", role: "context", threadId: thread.id
    }, { ...options, validateArtifact: async ({ artifactId, artifactType }) => ({ artifactId, artifactType, providerId: "local" }) }))
      .rejects.toThrow("changed the provider");
  });

  it("fails closed on a persisted state file with a malformed or incoherent provider id", async () => {
    const cases: readonly [string, (link: Record<string, unknown>) => void][] = [
      ["empty mcp server", (link) => { link.providerId = "mcp:"; }],
      ["unknown provider word", (link) => { link.providerId = "evil"; }],
      ["local with trailing space", (link) => { link.providerId = "local "; }],
      ["resource carrying a local provider", (link) => { link.artifactType = "resource"; link.providerId = "local"; }],
      ["task carrying an mcp provider", (link) => { link.providerId = "mcp:github"; }],
      ["calendar with double prefix", (link) => { link.artifactType = "calendar-event"; link.providerId = "calendar:calendar:gcal"; }],
      ["calendar carrying local provider", (link) => { link.artifactType = "calendar-event"; link.providerId = "local"; }]
    ];
    for (const [label, corrupt] of cases) {
      const file = stateFile();
      const options = deterministicOptions();
      const thread = await createPersonalThread(file, { kind: "work", title: `Reject ${label}` }, options);
      await linkArtifact(file, { artifactId: "task_seed", artifactType: "task", role: "context", threadId: thread.id }, options);
      const invalid = cloneState(await readAttunementState(file));
      corrupt(invalid.threads[0]!.links[0]!);
      writeFileSync(file, JSON.stringify(invalid), "utf8");
      await expect(readAttunementState(file), label).rejects.toBeInstanceOf(AttunementStoreError);
    }
  });
});
