import { describe, expect, it, vi } from "vitest";

import {
  CONTINUITY_SOURCE_PROJECTION_LIMITS,
  ContinuitySourceProjectionError,
  projectContinuityPackSources
} from "./continuity-source-projection.js";
import { fingerprintContinuityTaskState } from "./interaction-evidence.js";

type Data = Record<string, unknown>;

const RAW_TASK_UPDATED_AT = "revision-7";
const TASK_ID = "task_book-trip";

function reference(artifact: Data): Data {
  return {
    artifactId: artifact.artifactId,
    artifactType: artifact.artifactType,
    providerId: artifact.providerId,
    role: artifact.role
  };
}

function artifact(
  artifactType: string,
  fields: Data = {}
): Data {
  return {
    artifactId: `${artifactType}_1`,
    artifactType,
    providerId: artifactType === "calendar-event"
      ? "calendar:gcal"
      : artifactType === "resource"
        ? "mcp:github"
        : "local",
    role: "context",
    title: `${artifactType} title`,
    ...fields
  };
}

function allArtifacts(): Data[] {
  return [
    artifact("task", {
      artifactId: TASK_ID,
      role: "next-step",
      summary: "Compare the final three hotels",
      taskDueAt: "July 30, 2026 09:00:00 UTC",
      taskDueState: "due",
      taskStatus: "open",
      taskTags: ["travel", "decision", "travel"],
      title: "Book the hotel",
      updatedAt: RAW_TASK_UPDATED_AT
    }),
    artifact("note", {
      summary: "Owner-authored hotel comparison",
      updatedAt: "note-revision-11"
    }),
    artifact("reminder", {
      reminderDueAt: "July 30, 2026 10:00:00 UTC",
      reminderDueState: "due",
      reminderStatus: "pending",
      summary: "Cancellation deadline"
    }),
    artifact("calendar-event", {
      calendarAllDay: false,
      calendarEndsAt: "July 30, 2026 12:00:00 UTC",
      calendarLocation: "Seoul",
      calendarStartsAt: "July 30, 2026 11:00:00 UTC",
      calendarTimeState: "upcoming"
    }),
    artifact("contact", {
      contactBirthday: "07-30",
      contactRelationship: "travel companion"
    }),
    artifact("run", {
      runOutcome: "grounded",
      runRecordedAt: "July 29, 2026 08:00:00 UTC",
      runSuccess: true,
      runToolNames: ["calendar.read", "tasks.read", "calendar.read"]
    }),
    artifact("checkpoint", {
      checkpointPhase: "act",
      checkpointRecordedAt: "July 29, 2026 08:05:00 UTC",
      checkpointStep: 3
    }),
    artifact("browsing-visit", {
      browsingUrl: "https://hotel.example/rooms?owner=jinan",
      browsingVisitedAt: "July 29, 2026 08:10:00 UTC"
    }),
    artifact("conversation", {
      conversationLastOwnerPrompt: "저녁에 다시 보여줘",
      conversationOrigin: "web",
      conversationUpdatedAt: "July 29, 2026 08:15:00 UTC"
    }),
    artifact("work", {
      workBoardTaskCount: 5,
      workFlowCount: 2,
      workOutcomeCount: 1,
      workStatus: "active",
      workUpdatedAt: "July 29, 2026 08:20:00 UTC"
    }),
    artifact("resource", {
      summary: "External issue body selected by the owner"
    })
  ];
}

function packFor(artifacts = allArtifacts()): Data {
  const evidence = artifacts.map((entry) => ({
    artifact: entry,
    reference: reference(entry),
    status: "available"
  }));
  const task = artifacts.find((entry) => entry.artifactType === "task")!;
  return {
    deliveryPolicyVersion: 7,
    evidence,
    evidenceRefs: artifacts.map(reference),
    interactionAnchor: {
      artifactId: TASK_ID,
      linkedAt: "July 29, 2026 07:55:00 UTC",
      observedStatus: "open",
      openStateFingerprint: fingerprintContinuityTaskState({
        artifactId: TASK_ID,
        status: "open",
        updatedAt: RAW_TASK_UPDATED_AT
      }),
      providerId: "local",
      role: "next-step"
    },
    nextStep: task,
    policy: {
      detail: "standard",
      nextStep: "direct",
      suppression: "none",
      version: 7
    },
    thread: {
      id: "thread_trip",
      kind: "life",
      title: "Plan the summer trip"
    }
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectInvalid(value: unknown, code = "INVALID_PACK"): void {
  try {
    projectContinuityPackSources(value);
    throw new Error("expected projection to fail");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ContinuitySourceProjectionError);
    expect((cause as ContinuitySourceProjectionError).code).toBe(code);
  }
}

describe("projectContinuityPackSources", () => {
  it("projects every current source type without losing its typed personal fields", () => {
    const input = packFor();
    const projection = projectContinuityPackSources(input);

    expect(projection.schemaVersion).toBe(1);
    expect(projection.evidence.map((entry) => entry.reference.artifactType)).toEqual([
      "task",
      "note",
      "reminder",
      "calendar-event",
      "contact",
      "run",
      "checkpoint",
      "browsing-visit",
      "conversation",
      "work",
      "resource"
    ]);
    const projected = Object.fromEntries(projection.evidence.map((entry) => [
      entry.reference.artifactType,
      entry.artifact
    ]));
    expect(projected.task).toMatchObject({
      summary: "Compare the final three hotels",
      taskDueAt: "2026-07-30T09:00:00.000Z",
      taskTags: ["decision", "travel"],
      updatedAt: RAW_TASK_UPDATED_AT
    });
    expect(projected.reminder).toMatchObject({
      reminderDueAt: "2026-07-30T10:00:00.000Z",
      reminderDueState: "due"
    });
    expect(projected["calendar-event"]).toMatchObject({
      calendarEndsAt: "2026-07-30T12:00:00.000Z",
      calendarLocation: "Seoul",
      calendarStartsAt: "2026-07-30T11:00:00.000Z"
    });
    expect(projected.contact).toMatchObject({
      contactBirthday: "07-30",
      contactRelationship: "travel companion"
    });
    expect(projected.run).toMatchObject({
      runRecordedAt: "2026-07-29T08:00:00.000Z",
      runToolNames: ["calendar.read", "tasks.read"]
    });
    expect(projected["browsing-visit"]).toMatchObject({
      browsingUrl: "https://hotel.example/rooms?owner=jinan"
    });
    expect(projected.conversation).toMatchObject({
      conversationLastOwnerPrompt: "저녁에 다시 보여줘"
    });
    expect(projection).not.toHaveProperty("evidenceRefs");
    expect(projection).not.toHaveProperty("interactionAnchor");
  });

  it("returns an immutable detached projection and never mutates its input", () => {
    const input = packFor();
    const before = clone(input);
    const projection = projectContinuityPackSources(input);

    expect(input).toEqual(before);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.evidence)).toBe(true);
    expect(Object.isFrozen(projection.evidence[0]?.artifact)).toBe(true);
    expect(Object.isFrozen(projection.evidence[0]?.artifact?.taskTags)).toBe(true);

    ((input.evidence as Data[])[0]!.artifact as Data).title = "mutated later";
    expect(projection.nextStep?.title).toBe("Book the hotel");
  });

  it("canonicalizes only set-like fields and preserves meaningful source changes", () => {
    const left = packFor();
    const right = clone(left);
    const rightTask = ((right.evidence as Data[])[0]!.artifact as Data);
    rightTask.taskTags = ["travel", "decision"];
    const rightRun = (right.evidence as Data[]).find((entry) =>
      (entry.artifact as Data).artifactType === "run"
    )!.artifact as Data;
    rightRun.runToolNames = ["tasks.read", "calendar.read"];
    right.nextStep = rightTask;

    expect(JSON.stringify(projectContinuityPackSources(left))).toBe(
      JSON.stringify(projectContinuityPackSources(right))
    );

    rightTask.summary = "The cancellation policy changed";
    expect(JSON.stringify(projectContinuityPackSources(left))).not.toBe(
      JSON.stringify(projectContinuityPackSources(right))
    );
  });

  it("validates but strips a hidden-policy anchor without exposing the next step", () => {
    const input = packFor();
    (input.policy as Data).nextStep = "hidden";
    delete input.nextStep;

    const projection = projectContinuityPackSources(input);
    expect(projection.nextStep).toBeUndefined();
    expect(projection).not.toHaveProperty("interactionAnchor");
  });

  it.each([
    ["task", "reminderStatus", "pending"],
    ["note", "taskStatus", "open"],
    ["reminder", "calendarAllDay", false],
    ["calendar-event", "contactBirthday", "07-30"],
    ["contact", "runSuccess", true],
    ["run", "checkpointStep", 1],
    ["checkpoint", "browsingUrl", "https://example.com"],
    ["browsing-visit", "conversationOrigin", "web"],
    ["conversation", "workStatus", "active"],
    ["work", "taskTags", ["x"]],
    ["resource", "runOutcome", "grounded"]
  ])("rejects %s artifacts carrying foreign field %s", (artifactType, key, value) => {
    const target = allArtifacts().find((entry) => entry.artifactType === artifactType)!;
    target[key] = value;
    expectInvalid(packFor(allArtifacts().map((entry) =>
      entry.artifactType === artifactType ? target : entry
    )));
  });

  it("enforces evidence, policy, next-step, anchor, and previous-outcome coherence", () => {
    const cases: Array<readonly [string, Data]> = [];

    const versionMismatch = packFor();
    (versionMismatch.policy as Data).version = 8;
    cases.push(["version mismatch", versionMismatch]);

    const reorderedRefs = packFor();
    (reorderedRefs.evidenceRefs as Data[]).reverse();
    cases.push(["reference order", reorderedRefs]);

    const duplicateRefs = packFor();
    (duplicateRefs.evidenceRefs as Data[])[1] = clone(
      (duplicateRefs.evidenceRefs as Data[])[0]!
    );
    (duplicateRefs.evidence as Data[])[1] = clone(
      (duplicateRefs.evidence as Data[])[0]!
    );
    cases.push(["duplicate references", duplicateRefs]);

    const unavailableWithArtifact = packFor();
    ((unavailableWithArtifact.evidence as Data[])[1]!).status = "unavailable";
    cases.push(["unavailable artifact", unavailableWithArtifact]);

    const nextStepMismatch = packFor();
    nextStepMismatch.nextStep = clone(nextStepMismatch.nextStep as Data);
    (nextStepMismatch.nextStep as Data).title = "another task";
    cases.push(["next-step mismatch", nextStepMismatch]);

    const hiddenNextStep = packFor();
    (hiddenNextStep.policy as Data).nextStep = "hidden";
    cases.push(["hidden next-step", hiddenNextStep]);

    const badAnchor = packFor();
    (badAnchor.interactionAnchor as Data).openStateFingerprint = "bad";
    cases.push(["bad anchor", badAnchor]);

    const outcomeWithoutSuppression = packFor();
    outcomeWithoutSuppression.previousOutcome = "ignored";
    cases.push(["outcome suppression", outcomeWithoutSuppression]);

    for (const [label, candidate] of cases) {
      try {
        expectInvalid(candidate);
      } catch (cause) {
        throw new Error(`expected ${label} to fail`, { cause });
      }
    }
  });

  it("rejects multiple open local next steps and anchors without a candidate", () => {
    const duplicateTask = artifact("task", {
      artifactId: "task_second",
      role: "next-step",
      taskStatus: "open",
      title: "Second task",
      updatedAt: "revision-1"
    });
    expectInvalid(packFor([...allArtifacts(), duplicateTask]));

    const withoutTask = packFor(allArtifacts().filter(
      (entry) => entry.artifactType !== "task"
    ));
    expectInvalid(withoutTask);
  });

  it("accepts unavailable exact evidence but never fabricates an artifact", () => {
    const input = packFor();
    const evidence = input.evidence as Data[];
    const unavailable = evidence[1]!;
    delete unavailable.artifact;
    unavailable.status = "unavailable";

    const projection = projectContinuityPackSources(input);
    expect(projection.evidence[1]).toEqual({
      reference: (input.evidenceRefs as Data[])[1],
      status: "unavailable"
    });
  });

  it("rejects accessors, symbols, cycles, sparse arrays, exotic objects, and non-finite numbers", () => {
    const getter = vi.fn(() => "secret");
    const accessorPack = packFor();
    Object.defineProperty(accessorPack, "leak", { enumerable: true, get: getter });
    expectInvalid(accessorPack);
    expect(getter).not.toHaveBeenCalled();

    const symbolPack = packFor();
    Object.defineProperty(symbolPack, Symbol("secret"), {
      enumerable: true,
      value: "value"
    });
    expectInvalid(symbolPack);

    const cyclicPack = packFor();
    cyclicPack.self = cyclicPack;
    expectInvalid(cyclicPack);

    const sparsePack = packFor();
    sparsePack.evidence = new Array(2);
    expectInvalid(sparsePack);

    const exoticPack = packFor();
    exoticPack.thread = new Date();
    expectInvalid(exoticPack);

    const nonFinitePack = packFor();
    nonFinitePack.deliveryPolicyVersion = Number.POSITIVE_INFINITY;
    expectInvalid(nonFinitePack);

    const prototypePoisonPack = packFor();
    Object.defineProperty(prototypePoisonPack, "__proto__", {
      enumerable: true,
      value: { polluted: true }
    });
    expectInvalid(prototypePoisonPack);
    expect(({} as Data).polluted).toBeUndefined();
  });

  it("fails closed at evidence, set, string, depth, and descriptor budget edges", () => {
    const evidenceOverflow = packFor();
    evidenceOverflow.evidence = Array.from(
      { length: CONTINUITY_SOURCE_PROJECTION_LIMITS.maxEvidence + 1 },
      () => ({})
    );
    expectInvalid(evidenceOverflow, "BUDGET_EXCEEDED");

    const setOverflow = packFor();
    (((setOverflow.evidence as Data[])[0]!.artifact as Data).taskTags) =
      Array.from(
        { length: CONTINUITY_SOURCE_PROJECTION_LIMITS.maxSetItems + 1 },
        (_, index) => `tag-${index.toString()}`
      );
    expectInvalid(setOverflow, "BUDGET_EXCEEDED");

    const stringOverflow = packFor();
    (stringOverflow.thread as Data).title = "x".repeat(
      CONTINUITY_SOURCE_PROJECTION_LIMITS.maxStringBytes + 1
    );
    expectInvalid(stringOverflow, "BUDGET_EXCEEDED");

    const depthOverflow = packFor();
    let cursor: Data = depthOverflow;
    for (
      let depth = 0;
      depth <= CONTINUITY_SOURCE_PROJECTION_LIMITS.maxNestingDepth;
      depth += 1
    ) {
      cursor.tooDeep = {};
      cursor = cursor.tooDeep as Data;
    }
    expectInvalid(depthOverflow, "BUDGET_EXCEEDED");

    const descriptorOverflow = packFor();
    const manyFields: Data = {};
    for (
      let index = 0;
      index <= CONTINUITY_SOURCE_PROJECTION_LIMITS.maxDescriptors;
      index += 1
    ) {
      manyFields[`field${index.toString()}`] = true;
    }
    descriptorOverflow.extra = manyFields;
    expectInvalid(descriptorOverflow, "BUDGET_EXCEEDED");
  });

  it.each([
    ["invalid semantic instant", (input: Data) => {
      (((input.evidence as Data[])[0]!.artifact as Data).taskDueAt) = "never";
    }],
    ["negative count", (input: Data) => {
      const work = (input.evidence as Data[]).find((entry) =>
        (entry.artifact as Data).artifactType === "work"
      )!;
      (work.artifact as Data).workFlowCount = -1;
    }],
    ["incoherent provider", (input: Data) => {
      const resource = (input.evidence as Data[]).find((entry) =>
        (entry.artifact as Data).artifactType === "resource"
      )!;
      (resource.artifact as Data).providerId = "local";
    }],
    ["non-http browsing URL", (input: Data) => {
      const visit = (input.evidence as Data[]).find((entry) =>
        (entry.artifact as Data).artifactType === "browsing-visit"
      )!;
      (visit.artifact as Data).browsingUrl = "file:///private/notes";
    }],
    ["reversed calendar interval", (input: Data) => {
      const event = (input.evidence as Data[]).find((entry) =>
        (entry.artifact as Data).artifactType === "calendar-event"
      )!;
      (event.artifact as Data).calendarEndsAt = "July 30, 2026 10:00:00 UTC";
    }]
  ])("rejects %s", (_label, mutate) => {
    const input = packFor();
    mutate(input);
    expectInvalid(input);
  });
});
