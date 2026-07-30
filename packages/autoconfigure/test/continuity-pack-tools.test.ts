import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalArtifactValidator,
  createPersonalThread,
  linkArtifact,
  readAttunementState,
  type ContinuityPack
} from "@muse/attunement";
import type {
  ContinuityResumeRuntimeResultV1,
  ContinuityResumeRuntimeUnavailableReason
} from "@muse/attunegraph/continuity-resume-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly } from "../src/index.js";
import {
  createContinuityPackOpenTool,
  createContinuityPackPreviewTool
} from "../src/continuity-pack-tools.js";

let directory: string | undefined;

const UNAVAILABLE_REASONS = [
  "invalid-scope",
  "runtime-busy",
  "runtime-capacity",
  "operation-timeout",
  "capture-span-exceeded",
  "capture-failed",
  "provider-not-partial",
  "current-evidence-invalid",
  "observation-regressed",
  "observation-conflict",
  "resume-context-unavailable",
  "runtime-generation-changed"
] as const satisfies readonly ContinuityResumeRuntimeUnavailableReason[];

const CAPSULE_REQUEST = {
  locale: "en" as const,
  preparedWork: {
    content: "Prepare the next review draft.",
    expectedMinutes: 15,
    kind: "draft" as const,
    title: "Review draft"
  }
};

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("normal-chat Continuity Pack preview/open tools", () => {
  it("previews byte-identically and only an exact current digest opens one delivery", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-pack-"));
    const attunementFile = join(directory, "attunement.json");
    const notesDir = join(directory, "notes");
    const tasksFile = join(directory, "tasks.json");
    const task = {
      createdAt: "2026-07-28T00:00:00.000Z",
      id: "task_pack",
      status: "open",
      title: "Continue Pack work"
    } as const;
    await writeFile(tasksFile, JSON.stringify({ tasks: [task] }));
    const thread = await createPersonalThread(attunementFile, {
      kind: "work",
      title: "Daily agent release"
    });
    await linkArtifact(attunementFile, {
      artifactId: task.id,
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, {
      validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile })
    });
    const assembly = createMuseRuntimeAssembly({
      env: {
        HOME: directory,
        MUSE_ATTUNEMENT_FILE: attunementFile,
        MUSE_NOTES_DIR: notesDir,
        MUSE_TASKS_FILE: tasksFile
      }
    });
    const previews = assembly.toolRegistry.list().filter(
      (tool) => tool.definition.name === "muse.continuity.pack.preview"
    );
    const opens = assembly.toolRegistry.list().filter(
      (tool) => tool.definition.name === "muse.continuity.pack.open"
    );
    expect(previews).toHaveLength(1);
    expect(opens).toHaveLength(1);
    expect(previews[0]!.definition.risk).toBe("read");
    expect(opens[0]!.definition.risk).toBe("write");
    expect(previews[0]!.definition.description).toContain("never opens the Pack");
    expect(opens[0]!.definition.description).toContain("exactly one delivery receipt");

    const before = await readFile(attunementFile);
    const first = await previews[0]!.execute(
      { threadId: thread.id },
      { runId: "preview_1" }
    );
    const second = await previews[0]!.execute(
      { threadId: thread.id },
      { runId: "preview_2" }
    );
    expect(second).toMatchObject({
      mutation: false,
      pack: (first as { readonly pack: unknown }).pack,
      previewDigest:
        (first as { readonly previewDigest: string }).previewDigest,
      resume: {
        status: "partial",
        state: "compared-and-advanced",
        comparisonStatus: "no-change"
      }
    });
    expect(first).toMatchObject({
      mutation: false,
      pack: {
        evidenceCount: 1,
        thread: { id: thread.id },
        totalEvidence: 1,
        truncated: false
      },
      previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      resume: {
        status: "partial",
        state: "process-local-baseline-seeded",
        reason: "no-prior-process-local-baseline",
        authority: {
          canAssertCurrentWorldTruth: false,
          canAssertSourceCompleteness: false,
          canGrantActionAuthority: false
        }
      }
    });
    expect(JSON.stringify(second)).not.toMatch(
      /receiptId|boundaryId|graphEvidence|reservation|combinedCost|inventory|frontier|ledger|contextStream/
    );

    const withCapsule = await previews[0]!.execute({
      capsule: CAPSULE_REQUEST,
      threadId: thread.id
    }, { runId: "preview_capsule" });
    expect(withCapsule).toMatchObject({
      capsule: {
        locale: "en",
        preparedWork: {
          actionMode: "display-only",
          kind: "draft",
          title: "Review draft"
        },
        sourceDrawer: {
          currentObservedAt: expect.any(String),
          preparedAt: expect.any(String)
        }
      },
      mutation: false,
      previewDigest: (first as { readonly previewDigest: string }).previewDigest
    });
    const capsule = (withCapsule as { readonly capsule: {
      readonly sourceDrawer: { readonly currentObservedAt: string; readonly preparedAt: string };
    } }).capsule;
    expect(capsule.sourceDrawer.preparedAt).toBe(capsule.sourceDrawer.currentObservedAt);
    expect(JSON.stringify(withCapsule)).not.toMatch(
      /runtimeAudit|providerArtifact|reservation|retainedInventory|hiddenSideRegistry/
    );
    expect(await readFile(attunementFile)).toEqual(before);
    expect((await readAttunementState(attunementFile)).deliveries).toEqual([]);

    await expect(opens[0]!.execute({
      previewDigest: "0".repeat(64),
      threadId: thread.id
    }, { runId: "bad_digest" })).rejects.toThrow(/stale or does not match/u);
    expect(await readFile(attunementFile)).toEqual(before);

    const previewDigest = (first as { readonly previewDigest: string }).previewDigest;
    await writeFile(tasksFile, JSON.stringify({ tasks: [] }));
    await expect(opens[0]!.execute({
      previewDigest,
      threadId: thread.id
    }, { runId: "unavailable" })).rejects.toThrow(/stale or does not match/u);
    expect((await readAttunementState(attunementFile)).deliveries).toEqual([]);

    await writeFile(tasksFile, JSON.stringify({ tasks: [task] }));
    await expect(opens[0]!.execute({
      previewDigest,
      threadId: thread.id
    }, { runId: "open_1" })).resolves.toMatchObject({
      delivery: {
        evidenceCount: 1,
        id: expect.stringMatching(/^delivery_/u),
        threadId: thread.id
      },
      success: true
    });
    const state = await readAttunementState(attunementFile);
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0]).toMatchObject({
      evidenceClass: "organic",
      runId: "open_1",
      threadId: thread.id
    });
  });

  it("keeps open on the ordinary Pack dependency and never invokes resume", async () => {
    const threadId = "thread_dependency_split";
    const pack: ContinuityPack = {
      deliveryPolicyVersion: 0,
      evidence: [],
      evidenceRefs: [],
      policy: {
        detail: "compact",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      thread: {
        id: threadId,
        kind: "work",
        title: "Dependency split"
      }
    };
    let ordinaryReads = 0;
    let resumeReads = 0;
    let opens = 0;
    const preview = createContinuityPackPreviewTool({
      previewPack: async () => {
        ordinaryReads += 1;
        return pack;
      },
      previewResume: async () => {
        resumeReads += 1;
        return {
          pack,
          resume: {
            schemaVersion: 1,
            status: "partial",
            state: "process-local-baseline-seeded",
            reason: "no-prior-process-local-baseline",
            authority: {
              canAssertCurrentWorldTruth: false,
              canAssertSourceCompleteness: false,
              canGrantActionAuthority: false
            }
          }
        };
      }
    });
    const open = createContinuityPackOpenTool({
      previewPack: async () => {
        ordinaryReads += 1;
        return pack;
      },
      openPack: async (_threadId, runId) => {
        opens += 1;
        return {
          delivery: {
            evidenceClass: "organic",
            evidenceRefs: [],
            id: "delivery_dependency_split",
            openedAt: "2026-07-30T00:00:00.000Z",
            policyVersion: 0,
            runId,
            threadId
          },
          pack
        };
      }
    });
    const previewed = await preview.execute(
      { threadId },
      { runId: "dependency_preview" }
    );
    expect(resumeReads).toBe(1);
    expect(ordinaryReads).toBe(0);
    let runIdReads = 0;
    const changingContext = Object.defineProperty({}, "runId", {
      get() {
        runIdReads += 1;
        return runIdReads === 1 ? "dependency_open" : "forged_after_write";
      }
    });
    await open.execute({
      previewDigest:
        (previewed as { readonly previewDigest: string }).previewDigest,
      threadId
    }, changingContext as { readonly runId: string });
    expect(resumeReads).toBe(1);
    expect(ordinaryReads).toBe(1);
    expect(opens).toBe(1);
    expect(runIdReads).toBe(1);
  });

  it("does not present a Capsule from a forged compared result plus an unrelated Pack", async () => {
    const threadId = "thread_forged_capsule";
    const pack: ContinuityPack = {
      deliveryPolicyVersion: 0,
      evidence: [],
      evidenceRefs: [],
      policy: {
        detail: "compact",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      thread: { id: threadId, kind: "work", title: "Forged Capsule" }
    };
    const forgedCompared = Object.freeze({
      schemaVersion: 1,
      status: "partial",
      state: "compared-and-advanced",
      comparisonStatus: "no-change",
      witnessStatus: "partial",
      resumeContextFacts: { changes: [], status: "no-change" },
      supportingFacts: { changes: [], status: "no-change" },
      authority: {
        canAssertCurrentWorldTruth: false,
        canAssertSourceCompleteness: false,
        canGrantActionAuthority: false
      }
    }) as unknown as ContinuityResumeRuntimeResultV1;
    const preview = createContinuityPackPreviewTool({
      previewPack: async () => pack,
      previewResume: async () => ({ pack, resume: forgedCompared })
    });

    await expect(preview.execute(
      { capsule: CAPSULE_REQUEST, threadId },
      { runId: "forged_capsule" }
    )).resolves.toMatchObject({
      capsule: {
        reason: "exact-compared-evidence-unavailable",
        status: "unavailable"
      },
      pack: { thread: { id: threadId } },
      resume: { state: "compared-and-advanced", status: "partial" }
    });
  });

  it.each(UNAVAILABLE_REASONS)(
    "falls back to the ordinary Pack for unavailable reason %s",
    async (reason) => {
      const threadId = "thread_resume_fallback";
      const pack: ContinuityPack = {
        deliveryPolicyVersion: 0,
        evidence: [],
        evidenceRefs: [],
        policy: {
          detail: "compact",
          nextStep: "direct",
          suppression: "none",
          version: 0
        },
        thread: {
          id: threadId,
          kind: "work",
          title: "Fallback Pack"
        }
      };
      let ordinaryReads = 0;
      const preview = createContinuityPackPreviewTool({
        previewPack: async () => {
          ordinaryReads += 1;
          return pack;
        },
        previewResume: async () => ({
          resume: {
            schemaVersion: 1,
            status: "unavailable",
            reason,
            authority: {
              canAssertCurrentWorldTruth: false,
              canAssertSourceCompleteness: false,
              canGrantActionAuthority: false
            }
          }
        })
      });
      await expect(preview.execute(
        { capsule: CAPSULE_REQUEST, threadId },
        { runId: `fallback_${reason}` }
      )).resolves.toMatchObject({
        capsule: {
          reason: "exact-compared-evidence-unavailable",
          status: "unavailable"
        },
        mutation: false,
        pack: { thread: { id: threadId } },
        previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        resume: { status: "unavailable", reason }
      });
      expect(ordinaryReads).toBe(1);
    }
  );

  it("rejects extra, accessor, and custom-prototype input before reading a Pack", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-pack-shape-"));
    const preview = createMuseRuntimeAssembly({
      env: { HOME: directory }
    }).toolRegistry.list().find(
      (tool) => tool.definition.name === "muse.continuity.pack.preview"
    )!;
    let getterReads = 0;
    const accessor = Object.defineProperty({}, "threadId", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "thread_exact";
      }
    });
    const custom = Object.assign(Object.create({ inherited: true }), {
      threadId: "thread_exact"
    });
    let nestedGetterReads = 0;
    const nestedAccessor = {
      capsule: {
        locale: "en",
        preparedWork: Object.defineProperty({}, "kind", {
          enumerable: true,
          get: () => {
            nestedGetterReads += 1;
            return "draft";
          }
        })
      },
      threadId: "thread_exact"
    };
    let resumeReads = 0;
    const preflight = createContinuityPackPreviewTool({
      previewPack: async () => {
        throw new Error("invalid Capsule must not read the Pack");
      },
      previewResume: async () => {
        resumeReads += 1;
        throw new Error("invalid Capsule must not invoke the coordinator");
      }
    });

    await expect(preview.execute(
      { threadId: "thread_exact", open: true },
      { runId: "extra" }
    )).rejects.toThrow(/requires exactly threadId/u);
    await expect(preview.execute(accessor, { runId: "accessor" }))
      .rejects.toThrow(/plain data property/u);
    await expect(preview.execute(custom, { runId: "custom" }))
      .rejects.toThrow(/plain object/u);
    await expect(preview.execute(nestedAccessor, { runId: "nested_accessor" }))
      .rejects.toThrow(/Capsule request must use strict plain data/u);
    await expect(preflight.execute({
      capsule: {
        ...CAPSULE_REQUEST,
        preparedWork: { ...CAPSULE_REQUEST.preparedWork, expectedMinutes: 0 }
      },
      threadId: "thread_exact"
    }, { runId: "nested_semantic" })).rejects
      .toThrow(/Capsule request must use strict plain data/u);
    expect(getterReads).toBe(0);
    expect(nestedGetterReads).toBe(0);
    expect(resumeReads).toBe(0);
  });
});
