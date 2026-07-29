import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { prepareContinuityPack } from "./continuity-pack.js";
import {
  CONTINUITY_SOURCE_OBSERVATION_LIMITS,
  ContinuitySourceObservationError,
  captureContinuitySourceObservation,
  verifyContinuitySourceObservation,
  type ContinuitySourceObservationReceipt
} from "./continuity-source-observation.js";
import type {
  ArtifactLink,
  AttunementState,
  ContinuityPack,
  ResolvedArtifact
} from "./types.js";

type Data = Record<string, unknown>;

const OBSERVED_AT = "2026-07-29T09:00:00.000Z";
const HASH_DOMAIN =
  "muse.attunement.continuity-source-observation.v1\0";
const RECEIPT_ID_PREFIX =
  "muse-continuity-source-observation:v1:sha256:";

function reference(artifact: ResolvedArtifact): Data {
  return {
    artifactId: artifact.artifactId,
    artifactType: artifact.artifactType,
    providerId: artifact.providerId,
    role: artifact.role
  };
}

function artifact(
  artifactType: ResolvedArtifact["artifactType"],
  fields: Partial<ResolvedArtifact> = {}
): ResolvedArtifact {
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

function packFromArtifacts(
  artifacts: readonly ResolvedArtifact[]
): ContinuityPack {
  const evidence = artifacts.map((entry) => ({
    artifact: entry,
    reference: reference(entry) as unknown as ContinuityPack["evidenceRefs"][number],
    status: "available" as const
  }));
  return {
    deliveryPolicyVersion: 4,
    evidence,
    evidenceRefs: evidence.map((entry) => entry.reference),
    policy: {
      detail: "standard",
      nextStep: "direct",
      suppression: "none",
      version: 4
    },
    thread: {
      id: "thread_trip",
      kind: "life",
      title: "Plan the summer trip"
    }
  };
}

function representativePack(): ContinuityPack {
  return packFromArtifacts([
    artifact("task", {
      summary: "Compare the final three hotels",
      taskDueAt: "2026-07-29T08:00:00.000Z",
      taskDueState: "overdue",
      taskStatus: "open",
      taskTags: ["travel", "decision", "travel"],
      updatedAt: "task-revision-7"
    }),
    artifact("note", {
      summary: "Owner-authored comparison",
      updatedAt: "note-revision-11"
    }),
    artifact("reminder", {
      reminderDueAt: OBSERVED_AT,
      reminderDueState: "due",
      reminderStatus: "pending"
    }),
    artifact("calendar-event", {
      calendarAllDay: false,
      calendarEndsAt: "2026-07-29T10:00:00.000Z",
      calendarLocation: "Seoul",
      calendarStartsAt: OBSERVED_AT,
      calendarTimeState: "happening"
    }),
    artifact("contact", {
      contactBirthday: "07-30",
      contactRelationship: "travel companion"
    }),
    artifact("run", {
      runOutcome: "grounded",
      runRecordedAt: "2026-07-29T08:00:00.000Z",
      runSuccess: true,
      runToolNames: ["tasks.read", "calendar.read", "tasks.read"]
    }),
    artifact("checkpoint", {
      checkpointPhase: "act",
      checkpointRecordedAt: "2026-07-29T08:05:00.000Z",
      checkpointStep: 3
    }),
    artifact("browsing-visit", {
      browsingUrl: "https://hotel.example/rooms?owner=jinan",
      browsingVisitedAt: "2026-07-29T08:10:00.000Z"
    }),
    artifact("conversation", {
      conversationLastOwnerPrompt: "저녁에 다시 보여줘",
      conversationOrigin: "web",
      conversationUpdatedAt: "2026-07-29T08:15:00.000Z"
    }),
    artifact("work", {
      workBoardTaskCount: 5,
      workFlowCount: 2,
      workOutcomeCount: 1,
      workStatus: "active",
      workUpdatedAt: "2026-07-29T08:20:00.000Z"
    }),
    artifact("resource", {
      summary: "External issue selected by the owner"
    })
  ]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectObservationError(
  fn: () => unknown,
  code: ContinuitySourceObservationError["code"]
): void {
  try {
    fn();
    throw new Error("expected source observation to fail");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ContinuitySourceObservationError);
    expect((cause as ContinuitySourceObservationError).code).toBe(code);
  }
}

function rehash(
  receipt: ContinuitySourceObservationReceipt
): ContinuitySourceObservationReceipt {
  const { receiptId: _receiptId, ...body } = receipt;
  const digest = createHash("sha256")
    .update(HASH_DOMAIN, "utf8")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  return {
    ...body,
    receiptId: `${RECEIPT_ID_PREFIX}${digest}`
  };
}

function sourceState(links: readonly ArtifactLink[]): AttunementState {
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-29T07:00:00.000Z",
      id: "thread_trip",
      kind: "life",
      links,
      policy: {
        detail: "standard",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      title: "Plan the summer trip"
    }],
    undoResetReceipts: []
  };
}

function largePack(payloadBytes: number, utf8Bump = false): ContinuityPack {
  const artifacts: ResolvedArtifact[] = [];
  let remaining = payloadBytes;
  for (let index = 0; index < 128; index += 1) {
    const size = Math.min(16_000, remaining);
    remaining -= size;
    let summary = "x".repeat(size);
    if (utf8Bump && index === 0 && summary.length > 0) {
      summary = `é${summary.slice(1)}`;
    }
    artifacts.push(artifact("note", {
      artifactId: `n${index.toString()}`,
      summary,
      title: "n"
    }));
  }
  if (remaining !== 0) {
    throw new Error("large Pack payload exceeds fixture capacity");
  }
  return packFromArtifacts(artifacts);
}

describe("Continuity Source Observation Receipt", () => {
  it("captures all source display truth and verifies byte-identically after JSON round-trip", () => {
    const input = {
      observedAt: "July 29, 2026 09:00:00 UTC",
      pack: representativePack()
    };
    const before = clone(input);
    const receipt = captureContinuitySourceObservation(input);
    const verified = verifyContinuitySourceObservation(
      JSON.parse(JSON.stringify(receipt))
    );

    expect(input).toEqual(before);
    expect(verified).toEqual(receipt);
    expect(JSON.stringify(verified)).toBe(JSON.stringify(receipt));
    expect(receipt).toMatchObject({
      authority: "caller-declared-observation",
      formatVersion: "muse.continuity-source-observation.v1",
      observedAt: OBSERVED_AT,
      schemaVersion: 1,
      temporalRuleVersion: "muse.continuity-temporal-state.v1"
    });
    expect(receipt.projection.evidence).toHaveLength(11);
    expect(receipt.projection.evidence[7]?.artifact?.browsingUrl).toContain(
      "owner=jinan"
    );
    expect(
      receipt.projection.evidence[8]?.artifact?.conversationLastOwnerPrompt
    ).toBe("저녁에 다시 보여줘");
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.projection)).toBe(true);
    expect(Object.isFrozen(receipt.projection.evidence[0]?.artifact)).toBe(true);
  });

  it("matches a fixed portable hash golden vector", () => {
    const receipt = captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack: packFromArtifacts([
        artifact("note", {
          artifactId: "note_1",
          summary: "source truth",
          title: "Trip note"
        })
      ])
    });

    expect(receipt.receiptId).toBe(
      "muse-continuity-source-observation:v1:sha256:b9008bbb5a0b7132e3ba90538a12324f5f129116459954988eef4a4ac134a1f6"
    );
  });

  it("is independent of object key order and set order but binds meaningful changes", () => {
    const original = representativePack();
    const task = original.evidence[0]!.artifact!;
    const reorderedTask = {
      taskTags: ["decision", "travel"],
      title: task.title,
      role: task.role,
      providerId: task.providerId,
      artifactType: task.artifactType,
      artifactId: task.artifactId,
      updatedAt: task.updatedAt,
      taskStatus: task.taskStatus,
      taskDueState: task.taskDueState,
      taskDueAt: task.taskDueAt,
      summary: task.summary
    } as ResolvedArtifact;
    const reordered = packFromArtifacts([
      reorderedTask,
      ...original.evidence.slice(1).map((entry) => entry.artifact!)
    ]);
    const left = captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack: original
    });
    const right = captureContinuitySourceObservation({
      pack: reordered,
      observedAt: OBSERVED_AT
    });
    expect(right.receiptId).toBe(left.receiptId);

    const noteOnly = packFromArtifacts([
      artifact("note", { summary: "stable truth" })
    ]);
    const firstNoteReceipt = captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack: noteOnly
    });
    const later = captureContinuitySourceObservation({
      observedAt: "2026-07-29T09:00:00.001Z",
      pack: noteOnly
    });
    expect(later.receiptId).not.toBe(firstNoteReceipt.receiptId);

    const changed = clone(original);
    (changed.evidence[1]!.artifact as unknown as Data).summary =
      "changed source truth";
    expect(captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack: changed
    }).receiptId).not.toBe(left.receiptId);
  });

  it("accepts the exact task/reminder/calendar output of the shared Pack producer", async () => {
    const links: ArtifactLink[] = [
      {
        artifactId: "task_1",
        artifactType: "task",
        linkedAt: "2026-07-29T07:00:00.000Z",
        linkedBy: "user",
        providerId: "local",
        role: "next-step",
        threadId: "thread_trip"
      },
      {
        artifactId: "reminder_1",
        artifactType: "reminder",
        linkedAt: "2026-07-29T07:00:00.000Z",
        linkedBy: "user",
        providerId: "local",
        role: "context",
        threadId: "thread_trip"
      },
      {
        artifactId: "calendar_1",
        artifactType: "calendar-event",
        linkedAt: "2026-07-29T07:00:00.000Z",
        linkedBy: "user",
        providerId: "calendar:gcal",
        role: "context",
        threadId: "thread_trip"
      }
    ];
    const pack = await prepareContinuityPack(
      sourceState(links),
      "thread_trip",
      async (link) => {
        if (link.artifactType === "task") {
          return {
            artifactId: link.artifactId,
            artifactType: link.artifactType,
            providerId: link.providerId,
            role: link.role,
            taskDueAt: "2026-07-29T08:59:59.999Z",
            taskStatus: "open",
            title: "Book hotel",
            updatedAt: "revision-3"
          };
        }
        if (link.artifactType === "reminder") {
          return {
            artifactId: link.artifactId,
            artifactType: link.artifactType,
            providerId: link.providerId,
            role: link.role,
            reminderDueAt: OBSERVED_AT,
            reminderStatus: "pending",
            title: "Cancellation deadline"
          };
        }
        return {
          artifactId: link.artifactId,
          artifactType: link.artifactType,
          providerId: link.providerId,
          role: link.role,
          calendarEndsAt: "2026-07-29T10:00:00.000Z",
          calendarStartsAt: OBSERVED_AT,
          title: "Travel planning"
        };
      },
      { now: () => Date.parse(OBSERVED_AT) }
    );
    const receipt = captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack
    });

    expect(receipt.projection.evidence.map((entry) => [
      entry.reference.artifactType,
      entry.artifact?.taskDueState
        ?? entry.artifact?.reminderDueState
        ?? entry.artifact?.calendarTimeState
    ])).toEqual([
      ["task", "overdue"],
      ["reminder", "due"],
      ["calendar-event", "happening"]
    ]);
  });

  it.each([
    ["task equal", artifact("task", {
      taskDueAt: OBSERVED_AT,
      taskDueState: "due",
      taskStatus: "open"
    }), undefined],
    ["task one millisecond before", artifact("task", {
      taskDueAt: "2026-07-29T08:59:59.999Z",
      taskDueState: "overdue",
      taskStatus: "open"
    }), undefined],
    ["done task remains due", artifact("task", {
      taskDueAt: "2026-07-29T08:59:59.999Z",
      taskDueState: "due",
      taskStatus: "done"
    }), undefined],
    ["task missing derived state", artifact("task", {
      taskDueAt: OBSERVED_AT,
      taskStatus: "open"
    }), "TEMPORAL_INCOHERENCE"],
    ["task contradictory state", artifact("task", {
      taskDueAt: OBSERVED_AT,
      taskDueState: "overdue",
      taskStatus: "open"
    }), "TEMPORAL_INCOHERENCE"],
    ["reminder equal", artifact("reminder", {
      reminderDueAt: OBSERVED_AT,
      reminderDueState: "due",
      reminderStatus: "pending"
    }), undefined],
    ["reminder one millisecond before", artifact("reminder", {
      reminderDueAt: "2026-07-29T08:59:59.999Z",
      reminderDueState: "overdue",
      reminderStatus: "pending"
    }), undefined],
    ["pending reminder missing state", artifact("reminder", {
      reminderDueAt: OBSERVED_AT,
      reminderStatus: "pending"
    }), "TEMPORAL_INCOHERENCE"],
    ["calendar upcoming", artifact("calendar-event", {
      calendarEndsAt: "2026-07-29T10:00:00.000Z",
      calendarStartsAt: "2026-07-29T09:00:00.001Z",
      calendarTimeState: "upcoming"
    }), undefined],
    ["calendar start boundary", artifact("calendar-event", {
      calendarEndsAt: "2026-07-29T10:00:00.000Z",
      calendarStartsAt: OBSERVED_AT,
      calendarTimeState: "happening"
    }), undefined],
    ["calendar end boundary", artifact("calendar-event", {
      calendarEndsAt: OBSERVED_AT,
      calendarStartsAt: "2026-07-29T08:00:00.000Z",
      calendarTimeState: "happening"
    }), undefined],
    ["calendar one millisecond ended", artifact("calendar-event", {
      calendarEndsAt: "2026-07-29T08:59:59.999Z",
      calendarStartsAt: "2026-07-29T08:00:00.000Z",
      calendarTimeState: "ended"
    }), undefined],
    ["complete calendar missing state", artifact("calendar-event", {
      calendarEndsAt: "2026-07-29T10:00:00.000Z",
      calendarStartsAt: OBSERVED_AT
    }), "TEMPORAL_INCOHERENCE"],
    ["incomplete calendar without state", artifact("calendar-event", {
      calendarStartsAt: OBSERVED_AT
    }), undefined]
  ] as const)("enforces temporal truth: %s", (_label, source, errorCode) => {
    const run = () => captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack: packFromArtifacts([source])
    });
    if (errorCode) {
      expectObservationError(run, errorCode);
    } else {
      expect(run()).toBeDefined();
    }
  });

  it.each([
    ["due state without due time", artifact("task", {
      taskDueState: "due",
      taskStatus: "open"
    })],
    ["fired reminder with due state", artifact("reminder", {
      reminderDueAt: OBSERVED_AT,
      reminderDueState: "due",
      reminderStatus: "fired"
    })],
    ["incomplete calendar with state", artifact("calendar-event", {
      calendarStartsAt: OBSERVED_AT,
      calendarTimeState: "happening"
    })],
    ["reversed calendar", artifact("calendar-event", {
      calendarEndsAt: "2026-07-29T08:00:00.000Z",
      calendarStartsAt: "2026-07-29T10:00:00.000Z"
    })]
  ])("maps malformed projection before temporal checking: %s", (_label, source) => {
    expectObservationError(() =>
      captureContinuitySourceObservation({
        observedAt: OBSERVED_AT,
        pack: packFromArtifacts([source])
      }), "INVALID_INPUT");
  });

  it("rejects semantic tampering before integrity and valid tampering with a stale ID", () => {
    const receipt = captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack: representativePack()
    });
    const incoherent = clone(receipt);
    (
      incoherent.projection.evidence[0]!.artifact as unknown as Data
    ).taskDueState = "due";
    const rehashedIncoherent = rehash(incoherent);
    expectObservationError(
      () => verifyContinuitySourceObservation(rehashedIncoherent),
      "TEMPORAL_INCOHERENCE"
    );

    const staleId = clone(receipt);
    (staleId.projection.thread as Data).title = "Changed thread title";
    expectObservationError(
      () => verifyContinuitySourceObservation(staleId),
      "INTEGRITY_MISMATCH"
    );
  });

  it.each([
    ["schemaVersion", 2],
    ["formatVersion", "muse.continuity-source-observation.v2"],
    ["authority", "trusted-observer"],
    ["temporalRuleVersion", "muse.continuity-temporal-state.v2"],
    ["receiptId", "bad"]
  ])("rejects receipt envelope drift in %s", (key, value) => {
    const receipt = clone(captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack: representativePack()
    })) as unknown as Data;
    receipt[key] = value;
    expectObservationError(
      () => verifyContinuitySourceObservation(receipt),
      "INVALID_RECEIPT"
    );
  });

  it("rejects hostile envelope descriptors without invoking getters or changing thrown identity", () => {
    const getter = vi.fn(() => representativePack());
    const accessorInput = { observedAt: OBSERVED_AT };
    Object.defineProperty(accessorInput, "pack", {
      enumerable: true,
      get: getter
    });
    expectObservationError(
      () => captureContinuitySourceObservation(accessorInput),
      "INVALID_INPUT"
    );
    expect(getter).not.toHaveBeenCalled();

    const symbolInput = {
      observedAt: OBSERVED_AT,
      pack: representativePack()
    };
    Object.defineProperty(symbolInput, Symbol("secret"), {
      enumerable: true,
      value: true
    });
    expectObservationError(
      () => captureContinuitySourceObservation(symbolInput),
      "INVALID_INPUT"
    );

    const protoInput = {
      observedAt: OBSERVED_AT,
      pack: representativePack()
    };
    Object.defineProperty(protoInput, "__proto__", {
      enumerable: true,
      value: { polluted: true }
    });
    expectObservationError(
      () => captureContinuitySourceObservation(protoInput),
      "INVALID_INPUT"
    );
    expect(({} as Data).polluted).toBeUndefined();

    const sentinel = new Error("proxy sentinel");
    const proxy = new Proxy({}, {
      getPrototypeOf() {
        throw sentinel;
      }
    });
    expect(() => captureContinuitySourceObservation(proxy)).toThrow(sentinel);
    expect(() => verifyContinuitySourceObservation(proxy)).toThrow(sentinel);
  });

  it("maps nested hostile Pack data while preserving source-projection budgets", () => {
    const cyclic = representativePack() as unknown as Data;
    cyclic.self = cyclic;
    expectObservationError(
      () => captureContinuitySourceObservation({
        observedAt: OBSERVED_AT,
        pack: cyclic
      }),
      "INVALID_INPUT"
    );

    const sparse = representativePack() as unknown as Data;
    sparse.evidence = new Array(2);
    expectObservationError(
      () => captureContinuitySourceObservation({
        observedAt: OBSERVED_AT,
        pack: sparse
      }),
      "INVALID_INPUT"
    );

    const exotic = representativePack() as unknown as Data;
    exotic.thread = new Date();
    expectObservationError(
      () => captureContinuitySourceObservation({
        observedAt: OBSERVED_AT,
        pack: exotic
      }),
      "INVALID_INPUT"
    );

    const nonFinite = representativePack() as unknown as Data;
    nonFinite.deliveryPolicyVersion = Number.POSITIVE_INFINITY;
    expectObservationError(
      () => captureContinuitySourceObservation({
        observedAt: OBSERVED_AT,
        pack: nonFinite
      }),
      "INVALID_INPUT"
    );
  });

  it("distinguishes observedAt byte overflow from an at-limit invalid instant", () => {
    expectObservationError(
      () => captureContinuitySourceObservation({
        observedAt: "é".repeat(64),
        pack: representativePack()
      }),
      "INVALID_INPUT"
    );
    expectObservationError(
      () => captureContinuitySourceObservation({
        observedAt: `${"é".repeat(64)}x`,
        pack: representativePack()
      }),
      "BUDGET_EXCEEDED"
    );
  });

  it("accepts the exact complete-receipt byte limit and rejects a UTF-8 limit+1 body", () => {
    const baselinePayload = 900_000;
    const baseline = captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack: largePack(baselinePayload)
    });
    const baselineBytes = new TextEncoder().encode(
      JSON.stringify(baseline)
    ).byteLength;
    const exactPayload = baselinePayload
      + CONTINUITY_SOURCE_OBSERVATION_LIMITS.maxReceiptBytes
      - baselineBytes;
    const exact = captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack: largePack(exactPayload)
    });
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(
      CONTINUITY_SOURCE_OBSERVATION_LIMITS.maxReceiptBytes
    );

    expectObservationError(
      () => captureContinuitySourceObservation({
        observedAt: OBSERVED_AT,
        pack: largePack(exactPayload, true)
      }),
      "BUDGET_EXCEEDED"
    );
  });
});
