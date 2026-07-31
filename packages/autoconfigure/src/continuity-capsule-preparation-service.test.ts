import {
  createLocalArtifactValidator,
  createLocalExactArtifactResolver,
  createPersonalThread,
  linkArtifact
} from "@muse/attunement";
import {
  createLocalAttunementSnapshotProvider
} from "@muse/attunement/testing";
import {
  createContinuityResumeRuntimeCaptureAdapter,
  createContinuityResumeRuntimeCoordinator,
  type ContinuityResumeRuntimeResultV1
} from "@muse/attunegraph/continuity-resume-runtime";
import type { ModelResponse } from "@muse/model";
import { writeTasks } from "@muse/stores";
import {
  mkdir,
  mkdtemp,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  createContinuityCapsulePrepareTool
} from "./continuity-capsule-prepare-tool.js";
import {
  createContinuityCapsulePreparationService,
  type ContinuityCapsulePreparationService
} from "./continuity-capsule-preparation-service.js";

const roots: string[] = [];
const SOURCE_ID = "capsule-preparation-service-test";
const TASK_ID = "task_capsule_service";

interface Fixture {
  readonly attunementFile: string;
  readonly notesDir: string;
  readonly remindersFile: string;
  readonly tasksFile: string;
  readonly threadId: string;
}

async function linkUnsupportedCalendar(
  attunementFile: string,
  threadId: string
): Promise<void> {
  await linkArtifact(
    attunementFile,
    {
      artifactId: "calendar-event-service",
      artifactType: "calendar-event",
      providerId: "calendar:gcal",
      role: "context",
      threadId
    },
    {
      validateArtifact: async (reference) => Object.freeze({
        artifactId: reference.artifactId,
        artifactType: "calendar-event" as const,
        providerId: "calendar:gcal"
      })
    }
  );
}

async function addSupportedThread(
  input: Fixture,
  suffix: string
): Promise<string> {
  const thread = await createPersonalThread(input.attunementFile, {
    kind: "work",
    title: `Service-backed Capsule ${suffix}`
  });
  await linkArtifact(
    input.attunementFile,
    {
      artifactId: TASK_ID,
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    },
    {
      validateArtifact: createLocalArtifactValidator({
        notesDir: input.notesDir,
        remindersFile: input.remindersFile,
        tasksFile: input.tasksFile
      })
    }
  );
  return thread.id;
}

async function fixture(
  unsupported = false
): Promise<Fixture> {
  const root = await mkdtemp(join(
    tmpdir(),
    "muse-capsule-preparation-service-"
  ));
  roots.push(root);
  const attunementFile = join(root, "attunement.json");
  const notesDir = join(root, "notes");
  const remindersFile = join(root, "reminders.json");
  const tasksFile = join(root, "tasks.json");
  await mkdir(notesDir);
  await writeTasks(tasksFile, [{
    createdAt: "2026-07-31T00:00:00.000Z",
    id: TASK_ID,
    status: "open",
    title: "Resume the service-backed task"
  }]);
  const thread = await createPersonalThread(attunementFile, {
    kind: "work",
    title: "Service-backed Capsule"
  });
  await linkArtifact(
    attunementFile,
    {
      artifactId: TASK_ID,
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    },
    {
      validateArtifact: createLocalArtifactValidator({
        notesDir,
        remindersFile,
        tasksFile
      })
    }
  );
  if (unsupported) {
    await linkUnsupportedCalendar(attunementFile, thread.id);
  }
  return {
    attunementFile,
    notesDir,
    remindersFile,
    tasksFile,
    threadId: thread.id
  };
}

function realCoordinator(
  input: Fixture,
  sourceId = SOURCE_ID
) {
  const resolver = createLocalExactArtifactResolver({
    notesDir: input.notesDir,
    remindersFile: input.remindersFile,
    tasksFile: input.tasksFile
  });
  const snapshotProvider = createLocalAttunementSnapshotProvider({
    attunementFile: input.attunementFile,
    sourceId
  });
  return createContinuityResumeRuntimeCoordinator({
    captureCurrent: createContinuityResumeRuntimeCaptureAdapter({
      captureHeadRevalidation:
        snapshotProvider.captureHeadRevalidation,
      resolveExactArtifact: resolver
    })
  });
}

function modelResponse(request: unknown): ModelResponse {
  const messages = (request as {
    readonly messages: readonly { readonly content: string }[];
  }).messages;
  const marker = "Prepare from this JSON DATA:\n";
  const content = messages[1]!.content;
  const body = JSON.parse(
    content.slice(content.indexOf(marker) + marker.length)
  ) as {
    readonly currentNextStepSourceKey: string;
  };
  return Object.freeze({
    id: "service-response-1",
    model: "service-model",
    output: JSON.stringify({
      claims: [{
        text: "Review the exact service-backed next step.",
        sourceKeys: [body.currentNextStepSourceKey]
      }],
      expectedMinutes: 11
    })
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
  vi.restoreAllMocks();
});

describe("Continuity Capsule preparation service", () => {
  it("shares one coordinator across baseline seeding and ready preparation", async () => {
    const input = await fixture();
    const generate = vi.fn(async (request: unknown) =>
      modelResponse(request)
    );
    const service = createContinuityCapsulePreparationService({
      attunementFile: input.attunementFile,
      sourceId: SOURCE_ID,
      resumeCoordinator: realCoordinator(input),
      modelProvider: {
        id: "service-provider",
        generate
      },
      model: "service-model",
      now: () => new Date(Date.now() + 60_000)
    });

    await expect(service.prepare({
      locale: "en",
      threadId: input.threadId
    })).resolves.toMatchObject({
      status: "seeded",
      baselineDurability: "process-local-only",
      reason: "no-prior-process-local-baseline"
    });
    expect(generate).not.toHaveBeenCalled();

    const ready = await service.prepare({
      locale: "en",
      threadId: input.threadId
    });
    expect(ready).toMatchObject({
      status: "ready",
      receipt: {
        providerId: "service-provider",
        entailment: "not-verified"
      },
      presentation: {
        preparedWork: {
          actionMode: "display-only",
          title: "Prepared next-step draft"
        }
      }
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("maps the durable runtime seed without requiring model work", async () => {
    const input = await fixture();
    const preview = vi.fn(async (): Promise<
      ContinuityResumeRuntimeResultV1
    > => Object.freeze({
      schemaVersion: 1,
      status: "partial",
      state: "durable-baseline-seeded",
      reason: "no-prior-durable-baseline",
      authority: Object.freeze({
        canAssertCurrentWorldTruth: false,
        canAssertSourceCompleteness: false,
        canGrantActionAuthority: false
      })
    }));
    const service = createContinuityCapsulePreparationService({
      attunementFile: input.attunementFile,
      sourceId: SOURCE_ID,
      resumeCoordinator: { preview }
    });

    await expect(service.prepare({
      locale: "en",
      threadId: input.threadId
    })).resolves.toEqual({
      schemaVersion: 1,
      status: "seeded",
      state: "durable-baseline-seeded",
      reason: "no-prior-durable-baseline",
      baselineDurability: "durable-local",
      authority: {
        canAssertCurrentWorldTruth: false,
        canAssertSourceCompleteness: false,
        canGrantActionAuthority: false
      }
    });
    expect(preview).toHaveBeenCalledWith({
      sourceId: SOURCE_ID,
      threadId: input.threadId
    });
  });

  it("rejects exact compared results from another private scope before model work", async () => {
    const input = await fixture();
    const otherThreadId = await addSupportedThread(
      input,
      "substituted"
    );
    const mismatchedScopes = [
      {
        sourceId: SOURCE_ID,
        threadId: otherThreadId
      },
      {
        sourceId: "other-capsule-preparation-source",
        threadId: input.threadId
      }
    ] as const;

    for (const scope of mismatchedScopes) {
      const coordinator = realCoordinator(input, scope.sourceId);
      await coordinator.preview(scope);
      const substituted = await coordinator.preview(scope);
      const preview = vi.fn(async () => substituted);
      const generate = vi.fn(async (request: unknown) =>
        modelResponse(request)
      );
      const service = createContinuityCapsulePreparationService({
        attunementFile: input.attunementFile,
        sourceId: SOURCE_ID,
        resumeCoordinator: { preview },
        modelProvider: {
          id: "service-provider",
          generate
        },
        model: "service-model"
      });

      await expect(service.prepare({
        locale: "en",
        threadId: input.threadId
      })).resolves.toEqual({
        schemaVersion: 1,
        status: "unavailable",
        reason: "model-preparation-unavailable",
        preparationReason: "invalid-exact-result"
      });
      expect(preview).toHaveBeenCalledTimes(1);
      expect(generate).not.toHaveBeenCalled();
    }
  });

  it("rejects unsupported source classes before coordinator or model work", async () => {
    const input = await fixture(true);
    const preview = vi.fn<() => Promise<ContinuityResumeRuntimeResultV1>>();
    const generate = vi.fn(async () => modelResponse({}));
    const service = createContinuityCapsulePreparationService({
      attunementFile: input.attunementFile,
      sourceId: SOURCE_ID,
      resumeCoordinator: { preview },
      modelProvider: {
        id: "service-provider",
        generate
      },
      model: "service-model"
    });

    await expect(service.prepare({
      locale: "ko",
      threadId: input.threadId
    })).resolves.toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "unsupported-source-class",
      unsupportedSourceClasses: ["calendar-event"]
    });
    expect(preview).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("revalidates unsupported classes from the exact captured result", async () => {
    const input = await fixture();
    const coordinator = realCoordinator(input);
    let previews = 0;
    const preview = vi.fn(async (
      scope: Parameters<typeof coordinator.preview>[0]
    ) => {
      previews += 1;
      if (previews === 2) {
        await linkUnsupportedCalendar(
          input.attunementFile,
          input.threadId
        );
      }
      return coordinator.preview(scope);
    });
    const generate = vi.fn(async (request: unknown) =>
      modelResponse(request)
    );
    const service = createContinuityCapsulePreparationService({
      attunementFile: input.attunementFile,
      sourceId: SOURCE_ID,
      resumeCoordinator: { preview },
      modelProvider: {
        id: "service-provider",
        generate
      },
      model: "service-model",
      now: () => new Date(Date.now() + 60_000)
    });

    await expect(service.prepare({
      locale: "en",
      threadId: input.threadId
    })).resolves.toMatchObject({ status: "seeded" });
    await expect(service.prepare({
      locale: "en",
      threadId: input.threadId
    })).resolves.toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "unsupported-source-class",
      unsupportedSourceClasses: ["calendar-event"]
    });
    expect(preview).toHaveBeenCalledTimes(2);
    expect(generate).not.toHaveBeenCalled();
  });

  it("bounds same-scope concurrency before a second capture starts", async () => {
    const input = await fixture();
    let release!: (result: ContinuityResumeRuntimeResultV1) => void;
    const firstPreview = new Promise<ContinuityResumeRuntimeResultV1>(
      (resolve) => {
        release = resolve;
      }
    );
    const preview = vi.fn(() => firstPreview);
    const service = createContinuityCapsulePreparationService({
      attunementFile: input.attunementFile,
      sourceId: SOURCE_ID,
      resumeCoordinator: { preview }
    });

    const first = service.prepare({
      locale: "en",
      threadId: input.threadId
    });
    await vi.waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    await expect(service.prepare({
      locale: "ko",
      threadId: input.threadId
    })).resolves.toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "scope-busy"
    });
    release(Object.freeze({
      schemaVersion: 1,
      status: "partial",
      state: "process-local-baseline-seeded",
      reason: "no-prior-process-local-baseline",
      authority: Object.freeze({
        canAssertCurrentWorldTruth: false,
        canAssertSourceCompleteness: false,
        canGrantActionAuthority: false
      })
    }));
    await expect(first).resolves.toMatchObject({ status: "seeded" });
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("retains the scope slot until a timed-out provider settles", async () => {
    const input = await fixture();
    let settleLate!: (response: ModelResponse) => void;
    let lateRequest: unknown;
    const generate = vi.fn((request: unknown) => {
      if (lateRequest === undefined) {
        lateRequest = request;
        return new Promise<ModelResponse>((resolve) => {
          settleLate = resolve;
        });
      }
      return Promise.resolve(modelResponse(request));
    });
    const service = createContinuityCapsulePreparationService({
      attunementFile: input.attunementFile,
      sourceId: SOURCE_ID,
      resumeCoordinator: realCoordinator(input),
      modelProvider: {
        id: "service-provider",
        generate
      },
      model: "service-model",
      now: () => new Date(Date.now() + 60_000),
      timeoutMs: 100
    });

    await expect(service.prepare({
      locale: "en",
      threadId: input.threadId
    })).resolves.toMatchObject({ status: "seeded" });
    await expect(service.prepare({
      locale: "en",
      threadId: input.threadId
    })).resolves.toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "model-preparation-unavailable",
      preparationReason: "provider-timeout"
    });
    await expect(service.prepare({
      locale: "ko",
      threadId: input.threadId
    })).resolves.toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "scope-busy"
    });
    expect(generate).toHaveBeenCalledTimes(1);

    settleLate(modelResponse(lateRequest));
    await Promise.resolve();
    await Promise.resolve();
    await expect(service.prepare({
      locale: "en",
      threadId: input.threadId
    })).resolves.toMatchObject({ status: "ready" });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("caps actual abort-ignoring provider calls after four timeouts", async () => {
    const input = await fixture();
    const threadIds = [
      input.threadId,
      ...await Promise.all(
        ["two", "three", "four", "five"].map((suffix) =>
          addSupportedThread(input, suffix)
        )
      )
    ];
    const late: Array<(response: ModelResponse) => void> = [];
    const requests: unknown[] = [];
    let active = 0;
    let peak = 0;
    const generate = vi.fn((request: unknown) => {
      const callIndex = requests.length;
      requests.push(request);
      active += 1;
      peak = Math.max(peak, active);
      if (callIndex < 4) {
        return new Promise<ModelResponse>((resolve) => {
          late.push((response) => {
            active -= 1;
            resolve(response);
          });
        });
      }
      active -= 1;
      return Promise.resolve(modelResponse(request));
    });
    const service = createContinuityCapsulePreparationService({
      attunementFile: input.attunementFile,
      sourceId: SOURCE_ID,
      resumeCoordinator: realCoordinator(input),
      modelProvider: {
        id: "service-provider",
        generate
      },
      model: "service-model",
      now: () => new Date(Date.now() + 60_000),
      timeoutMs: 100
    });
    for (const threadId of threadIds) {
      await expect(service.prepare({
        locale: "en",
        threadId
      })).resolves.toMatchObject({ status: "seeded" });
    }

    vi.useFakeTimers({ toFake: ["clearTimeout", "setTimeout"] });
    const controllers = [new AbortController(), new AbortController()];
    const timed = threadIds.slice(0, 4).map((threadId, index) =>
      service.prepare({
        locale: "en",
        threadId,
        ...(index < controllers.length
          ? { signal: controllers[index]!.signal }
          : {})
      })
    );
    for (let turn = 0; turn < 100 && generate.mock.calls.length < 4; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(generate).toHaveBeenCalledTimes(4);
    controllers[0]!.abort(new Error("cancel first"));
    controllers[1]!.abort(new Error("cancel second"));
    const cancelled = await Promise.all(timed.slice(0, 2));
    for (const result of cancelled) {
      expect(result).toMatchObject({
        status: "unavailable",
        reason: "model-preparation-unavailable",
        preparationReason: "provider-cancelled"
      });
    }
    await vi.advanceTimersByTimeAsync(100);
    const timeoutResults = await Promise.all(timed.slice(2));
    for (const result of timeoutResults) {
      expect(result).toMatchObject({
        status: "unavailable",
        reason: "model-preparation-unavailable",
        preparationReason: "provider-timeout"
      });
    }
    expect(active).toBe(4);
    expect(peak).toBe(4);
    await expect(service.prepare({
      locale: "en",
      threadId: threadIds[0]!
    })).resolves.toMatchObject({
      status: "unavailable",
      reason: "scope-busy"
    });
    await expect(service.prepare({
      locale: "en",
      threadId: threadIds[4]!
    })).resolves.toMatchObject({
      status: "unavailable",
      reason: "service-capacity"
    });
    expect(generate).toHaveBeenCalledTimes(4);

    for (let index = 0; index < late.length; index += 1) {
      late[index]!(modelResponse(requests[index]));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retried = await service.prepare({
      locale: "en",
      threadId: threadIds[0]!
    });
    if (retried.status !== "ready") {
      throw new Error(`late provider slot did not release: ${JSON.stringify(retried)}`);
    }
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });

  it("exposes exactly threadId and locale through the no-caller-text tool", async () => {
    const prepare = vi.fn(async () => Object.freeze({
      schemaVersion: 1 as const,
      status: "unavailable" as const,
      reason: "thread-not-found" as const
    }));
    const service: ContinuityCapsulePreparationService =
      Object.freeze({ prepare });
    const tool = createContinuityCapsulePrepareTool(service);
    expect(tool.definition).toMatchObject({
      inputSchema: {
        additionalProperties: false,
        required: ["threadId", "locale"]
      },
      name: "muse.continuity.capsule.prepare",
      risk: "write"
    });

    await expect(tool.execute({
      locale: "en",
      preparedWork: { content: "caller text" },
      threadId: "thread_tool_capsule"
    }, {} as never)).rejects.toThrow(/exactly threadId and locale/u);
    expect(prepare).not.toHaveBeenCalled();

    await expect(tool.execute({
      locale: "ko",
      threadId: "thread_tool_capsule"
    }, {} as never)).resolves.toEqual({
      completed: true,
      mutation: false,
      mutationStatus: "none",
      mutationScopes: [],
      sourceMutation: false,
      schemaVersion: 1,
      status: "unavailable",
      reason: "thread-not-found"
    });
    expect(prepare).toHaveBeenCalledWith({
      locale: "ko",
      threadId: "thread_tool_capsule"
    });
  });

  it("projects the coordinator mutation receipt through Capsule preparation", async () => {
    const input = await fixture();
    const service = createContinuityCapsulePreparationService({
      attunementFile: input.attunementFile,
      sourceId: SOURCE_ID,
      resumeCoordinator: realCoordinator(input)
    });
    const tool = createContinuityCapsulePrepareTool(service);

    await expect(tool.execute({
      locale: "en",
      threadId: input.threadId
    }, {} as never)).resolves.toMatchObject({
      completed: true,
      mutation: true,
      mutationScope: "internal-comparison-baseline",
      mutationStatus: "committed",
      mutationScopes: ["internal-comparison-baseline"],
      status: "seeded"
    });
  });
});
