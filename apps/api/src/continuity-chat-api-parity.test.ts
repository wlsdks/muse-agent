import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import {
  readAttunementState,
  type AttunementState
} from "@muse/attunement";
import { writeTasks, type PersistedTask } from "@muse/stores";
import type { JsonObject } from "@muse/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerAttunementRoutes } from "./attunement-routes.js";
import { executeChatApproval } from "./chat-approval-execute.js";
import { chatWriteApprovalWiring } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

const TASK: PersistedTask = {
  createdAt: "2026-07-28T00:00:00.000Z",
  id: "task_parity",
  status: "open",
  title: "Prove shared Continuity reducer"
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

interface SurfaceFixture {
  readonly attunementFile: string;
  readonly env: Record<string, string>;
  readonly notesDir: string;
  readonly root: string;
  readonly tasksFile: string;
}

async function fixture(label: string): Promise<SurfaceFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `muse-parity-${label}-`)));
  roots.push(root);
  const notesDir = join(root, "notes");
  const tasksFile = join(root, "tasks.json");
  const attunementFile = join(root, "attunement.json");
  await mkdir(notesDir);
  await writeTasks(tasksFile, [TASK]);
  return {
    attunementFile,
    env: {
      HOME: root,
      MUSE_ATTUNEMENT_FILE: attunementFile,
      MUSE_CHAT_WRITE_ENABLED: "true",
      MUSE_NOTES_DIR: notesDir,
      MUSE_PENDING_APPROVALS_FILE: join(root, "pending.json"),
      MUSE_QUALIFICATION_LEARNING_HOLD_FILE: join(root, "qualification-hold.json"),
      MUSE_REMINDERS_FILE: join(root, "reminders.json"),
      MUSE_TASKS_FILE: tasksFile
    },
    notesDir,
    root,
    tasksFile
  };
}

function tool(
  assembly: ReturnType<typeof createMuseRuntimeAssembly>,
  name: string
) {
  const selected = assembly.toolRegistry.list().filter(
    (candidate) => candidate.definition.name === name
  );
  expect(selected).toHaveLength(1);
  return selected[0]!;
}

async function approveChatWrite(
  target: SurfaceFixture,
  selected: ReturnType<typeof tool>,
  arguments_: JsonObject,
  callId: string
): Promise<JsonObject> {
  const wiring = chatWriteApprovalWiring({ env: target.env } as ServerOptions)!;
  expect(wiring.toolApprovalGate({
    risk: "write",
    runId: `proposal_${callId}`,
    toolCall: {
      arguments: arguments_,
      id: callId,
      name: selected.definition.name
    },
    userId: "owner"
  })).toMatchObject({
    allowed: false,
    reason: expect.stringContaining("awaiting your approval")
  });
  const pending = await wiring.persist("owner");
  expect(pending).toHaveLength(1);
  const approved = await executeChatApproval({
    id: pending[0]!.id,
    pendingFile: target.env.MUSE_PENDING_APPROVALS_FILE!,
    requestUserId: "owner",
    resolveTool: (name) => name === selected.definition.name ? selected : undefined
  });
  expect(approved).toMatchObject({
    body: {
      ran: true,
      state: "succeeded",
      tool: selected.definition.name
    },
    statusCode: 200
  });
  return approved.body["result"] as JsonObject;
}

async function runChatSequence(target: SurfaceFixture): Promise<AttunementState> {
  const assembly = createMuseRuntimeAssembly({ env: target.env });
  const createThread = tool(assembly, "muse.continuity.thread.create");
  const previewLink = tool(assembly, "muse.continuity.task.link.preview");
  const linkTask = tool(assembly, "muse.continuity.task.link");
  const previewPack = tool(assembly, "muse.continuity.pack.preview");
  const openPack = tool(assembly, "muse.continuity.pack.open");
  const recordOutcome = tool(assembly, "muse.continuity.delivery.outcome");

  const created = await approveChatWrite(target, createThread, {
    kind: "work",
    title: "Provider-neutral daily agent"
  }, "chat_create");
  const threadId = (created["thread"] as JsonObject)["id"] as string;
  const linkProposal = {
    expectedTitle: TASK.title,
    role: "context",
    taskId: TASK.id,
    threadId
  };
  const linkPreview = await previewLink.execute(
    linkProposal,
    { runId: "chat_link_preview" }
  ) as JsonObject;
  await approveChatWrite(target, linkTask, {
    ...linkProposal,
    previewDigest: linkPreview["previewDigest"] as string
  }, "chat_link");
  const packPreview = await approveChatWrite(target, previewPack, {
    threadId
  }, "chat_pack_preview");
  const opened = await approveChatWrite(target, openPack, {
    previewDigest: packPreview["previewDigest"] as string,
    threadId
  }, "chat_open");
  const deliveryId = (opened["delivery"] as JsonObject)["id"] as string;
  await approveChatWrite(target, recordOutcome, {
    deliveryId,
    outcome: "used"
  }, "chat_outcome");

  return readAttunementState(target.attunementFile);
}

async function runApiSequence(target: SurfaceFixture): Promise<AttunementState> {
  const app = Fastify();
  registerAttunementRoutes(app, {
    attunementFile: target.attunementFile,
    authService: undefined,
    browsingFile: join(target.root, "browsing.json"),
    checkpointsDir: join(target.root, "checkpoints"),
    contactsFile: join(target.root, "contacts.json"),
    conversationsFile: join(target.root, "conversations.json"),
    env: target.env,
    notesDir: target.notesDir,
    now: () => Date.parse("2026-07-28T12:00:00.000Z"),
    remindersFile: target.env.MUSE_REMINDERS_FILE,
    tasksFile: target.tasksFile,
    worksFile: join(target.root, "works.json")
  });
  const created = await app.inject({
    method: "POST",
    payload: { kind: "work", title: "Provider-neutral daily agent" },
    url: "/api/attunement/threads"
  });
  expect(created.statusCode).toBe(200);
  const threadId = created.json<{ readonly id: string }>().id;
  const linked = await app.inject({
    method: "POST",
    payload: {
      artifactId: TASK.id,
      artifactType: "task",
      role: "context"
    },
    url: `/api/attunement/threads/${threadId}/links`
  });
  expect(linked.statusCode).toBe(200);
  const opened = await app.inject({
    method: "POST",
    url: `/api/attunement/threads/${threadId}/continue`
  });
  expect(opened.statusCode).toBe(200);
  const deliveryId = opened.json<{
    readonly delivery: { readonly id: string };
  }>().delivery.id;
  const outcome = await app.inject({
    method: "POST",
    payload: { outcome: "used" },
    url: `/api/attunement/deliveries/${deliveryId}/outcome`
  });
  expect(outcome.statusCode).toBe(200);
  await app.close();
  return readAttunementState(target.attunementFile);
}

function canonicalProjection(state: AttunementState): JsonObject {
  const threadKeyById = new Map(state.threads.map((thread) => [
    thread.id,
    `${thread.kind}:${thread.title}`
  ]));
  const deliveryKeyById = new Map(state.deliveries.map((delivery) => [
    delivery.id,
    `${threadKeyById.get(delivery.threadId) ?? "missing-thread"}:${delivery.policyVersion.toString()}`
  ]));
  return {
    deliveries: state.deliveries.map((delivery) => ({
      evidenceClass: delivery.evidenceClass,
      evidenceRefs: delivery.evidenceRefs.map((reference) => ({
        artifactId: reference.artifactId,
        artifactType: reference.artifactType,
        providerId: reference.providerId,
        role: reference.role
      })),
      ...(delivery.outcome ? {
        outcome: {
          evidenceClass: delivery.outcome.evidenceClass,
          outcome: delivery.outcome.outcome,
          ...(delivery.outcome.ownerNote
            ? { ownerNote: delivery.outcome.ownerNote }
            : {}),
          policyVersion: delivery.outcome.policyVersion
        }
      } : {}),
      policyVersion: delivery.policyVersion,
      threadKey: threadKeyById.get(delivery.threadId) ?? "missing-thread"
    })),
    interactionReceipts: state.interactionReceipts.map((receipt) => ({
      artifactId: receipt.artifactId,
      deliveryKey: deliveryKeyById.get(receipt.deliveryId) ?? "missing-delivery",
      evidenceClass: receipt.evidenceClass,
      providerId: receipt.providerId,
      role: receipt.role,
      threadKey: threadKeyById.get(receipt.threadId) ?? "missing-thread",
      transition: receipt.transition
    })),
    nextPolicyVersion: state.nextPolicyVersion,
    resetReceipts: state.resetReceipts.map((receipt) => ({
      basePolicyVersion: receipt.basePolicyVersion,
      beforePolicy: {
        detail: receipt.beforePolicy.detail,
        nextStep: receipt.beforePolicy.nextStep,
        suppression: receipt.beforePolicy.suppression,
        version: receipt.beforePolicy.version
      },
      resetPolicyVersion: receipt.resetPolicyVersion,
      threadKey: threadKeyById.get(receipt.threadId) ?? "missing-thread"
    })),
    threads: state.threads.map((thread) => ({
      kind: thread.kind,
      links: thread.links.map((link) => ({
        artifactId: link.artifactId,
        artifactType: link.artifactType,
        linkedBy: link.linkedBy,
        providerId: link.providerId,
        role: link.role
      })),
      policy: {
        detail: thread.policy.detail,
        nextStep: thread.policy.nextStep,
        suppression: thread.policy.suppression,
        version: thread.policy.version
      },
      title: thread.title
    })),
    undoResetReceipts: state.undoResetReceipts.map((receipt) => ({
      previousPolicyVersion: receipt.previousPolicyVersion,
      resetPolicyVersion: state.resetReceipts.find(
        (reset) => reset.id === receipt.resetId
      )?.resetPolicyVersion ?? -1,
      restoredPolicy: {
        detail: receipt.restoredPolicy.detail,
        nextStep: receipt.restoredPolicy.nextStep,
        suppression: receipt.restoredPolicy.suppression,
        version: receipt.restoredPolicy.version
      },
      threadKey: threadKeyById.get(receipt.threadId) ?? "missing-thread",
      undoPolicyVersion: receipt.undoPolicyVersion
    }))
  };
}

function projectionDigest(projection: JsonObject): string {
  return createHash("sha256")
    .update(JSON.stringify(projection))
    .digest("hex");
}

describe("normal-chat and API Continuity parity", () => {
  it("produces the same canonical reducer projection and digest for one complete operation sequence", async () => {
    const chatState = await runChatSequence(await fixture("chat"));
    const apiState = await runApiSequence(await fixture("api"));
    const chatProjection = canonicalProjection(chatState);
    const apiProjection = canonicalProjection(apiState);

    expect(chatProjection).toEqual(apiProjection);
    expect(projectionDigest(chatProjection)).toBe(projectionDigest(apiProjection));
    expect(chatProjection).toMatchObject({
      deliveries: [{
        evidenceClass: "organic",
        outcome: { evidenceClass: "organic", outcome: "used" }
      }],
      interactionReceipts: [],
      nextPolicyVersion: 2,
      resetReceipts: [],
      threads: [{
        kind: "work",
        links: [{
          artifactId: TASK.id,
          artifactType: "task",
          linkedBy: "user",
          providerId: "local",
          role: "context"
        }],
        title: "Provider-neutral daily agent"
      }],
      undoResetReceipts: []
    });
  });
});
