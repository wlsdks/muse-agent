import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import {
  createLocalArtifactValidator,
  createPersonalThread,
  linkArtifact,
  readAttunementState
} from "@muse/attunement";
import { afterEach, describe, expect, it } from "vitest";

import { executeChatApproval } from "./chat-approval-execute.js";
import { CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST } from "./chat-write-allowlist.js";
import { chatWriteApprovalWiring } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("normal-chat Continuity Pack open approval", () => {
  it("approval-gates the internal Preview write and opens exactly once after a separate owner approval", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-pack-approval-"));
    const attunementFile = join(directory, "attunement.json");
    const baselineFile = join(
      directory,
      ".muse",
      "continuity-resume-baselines.json"
    );
    const notesDir = join(directory, "notes");
    const pendingFile = join(directory, "pending.json");
    const tasksFile = join(directory, "tasks.json");
    await writeFile(tasksFile, JSON.stringify({
      tasks: [{
        createdAt: "2026-07-28T00:00:00.000Z",
        id: "task_pack_open",
        status: "open",
        title: "Open exact Pack"
      }]
    }));
    const thread = await createPersonalThread(attunementFile, {
      kind: "life",
      title: "Return moment"
    });
    await linkArtifact(attunementFile, {
      artifactId: "task_pack_open",
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, {
      validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile })
    });
    const env = {
      HOME: directory,
      MUSE_ATTUNEMENT_FILE: attunementFile,
      MUSE_CHAT_WRITE_ENABLED: "true",
      MUSE_NOTES_DIR: notesDir,
      MUSE_PENDING_APPROVALS_FILE: pendingFile,
      MUSE_TASKS_FILE: tasksFile
    };
    const assembly = createMuseRuntimeAssembly({ env });
    const preview = assembly.toolRegistry.list().find(
      (tool) => tool.definition.name === "muse.continuity.pack.preview"
    )!;
    const prepare = assembly.toolRegistry.list().find(
      (tool) => tool.definition.name === "muse.continuity.capsule.prepare"
    )!;
    const open = assembly.toolRegistry.list().find(
      (tool) => tool.definition.name === "muse.continuity.pack.open"
    )!;
    const before = await readFile(attunementFile);
    expect(CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST).toContain(
      preview.definition.name
    );
    expect(CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST).toContain(
      prepare.definition.name
    );
    const prepareWiring =
      chatWriteApprovalWiring({ env } as ServerOptions)!;
    expect(prepareWiring.toolApprovalGate({
      risk: "write",
      runId: "prepare_proposal",
      toolCall: {
        arguments: { locale: "en", threadId: thread.id },
        id: "call_prepare",
        name: prepare.definition.name
      },
      userId: "owner"
    })).toMatchObject({ allowed: false });
    await expect(readFile(baselineFile)).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readFile(attunementFile)).toEqual(before);

    const preparePending = await prepareWiring.persist("owner");
    expect(preparePending).toHaveLength(1);
    const prepareApproved = await executeChatApproval({
      id: preparePending[0]!.id,
      pendingFile,
      requestUserId: "owner",
      resolveTool: (name) =>
        name === prepare.definition.name ? prepare : undefined
    });
    expect(prepareApproved).toMatchObject({
      body: {
        ran: true,
        result: {
          baselineDurability: "durable-local",
          completed: true,
          status: "seeded"
        },
        state: "succeeded",
        tool: prepare.definition.name
      },
      statusCode: 200
    });
    const baselineAfterPrepare = await readFile(baselineFile, "utf8");
    expect(JSON.parse(baselineAfterPrepare)).toMatchObject({
      baselines: [{ scope: { threadId: thread.id } }],
      schemaVersion: 1
    });
    expect(await readFile(attunementFile)).toEqual(before);

    const previewWiring =
      chatWriteApprovalWiring({ env } as ServerOptions)!;
    expect(previewWiring.toolApprovalGate({
      risk: "write",
      runId: "preview_proposal",
      toolCall: {
        arguments: { threadId: thread.id },
        id: "call_preview",
        name: preview.definition.name
      },
      userId: "owner"
    })).toMatchObject({ allowed: false });
    expect(await readFile(baselineFile, "utf8")).toEqual(
      baselineAfterPrepare
    );
    expect(await readFile(attunementFile)).toEqual(before);

    const previewPending = await previewWiring.persist("owner");
    expect(previewPending).toHaveLength(1);
    const previewApproved = await executeChatApproval({
      id: previewPending[0]!.id,
      pendingFile,
      requestUserId: "owner",
      resolveTool: (name) =>
        name === preview.definition.name ? preview : undefined
    });
    expect(previewApproved).toMatchObject({
      body: {
        ran: true,
        result: {
          completed: true,
          mutation: true,
          mutationScope: "internal-comparison-baseline",
          sourceMutation: false
        },
        state: "succeeded",
        tool: preview.definition.name
      },
      statusCode: 200
    });
    expect(await readFile(attunementFile)).toEqual(before);
    const baselineAfterPreview = await readFile(baselineFile, "utf8");
    const previewReplay = await executeChatApproval({
      id: previewPending[0]!.id,
      pendingFile,
      requestUserId: "owner",
      resolveTool: () => preview
    });
    expect(previewReplay).toMatchObject({
      body: { state: "succeeded" },
      statusCode: 409
    });
    expect(await readFile(baselineFile, "utf8")).toEqual(
      baselineAfterPreview
    );

    const previewed = previewApproved.body["result"] as {
      readonly previewDigest: string;
    };
    const openWiring = chatWriteApprovalWiring({ env } as ServerOptions)!;
    const arguments_ = {
      previewDigest: previewed.previewDigest,
      threadId: thread.id
    };
    expect(CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST).toContain(open.definition.name);
    expect(openWiring.toolApprovalGate({
      risk: "write",
      runId: "proposal",
      toolCall: {
        arguments: arguments_,
        id: "call_open",
        name: open.definition.name
      },
      userId: "owner"
    })).toMatchObject({ allowed: false });
    expect(await readFile(attunementFile)).toEqual(before);

    const pending = await openWiring.persist("owner");
    expect(pending).toHaveLength(1);
    expect((await readAttunementState(attunementFile)).deliveries).toEqual([]);
    const approved = await executeChatApproval({
      id: pending[0]!.id,
      pendingFile,
      requestUserId: "owner",
      resolveTool: (name) => name === open.definition.name ? open : undefined
    });
    expect(approved).toMatchObject({
      body: { ran: true, state: "succeeded", tool: open.definition.name },
      statusCode: 200
    });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(1);

    const replay = await executeChatApproval({
      id: pending[0]!.id,
      pendingFile,
      requestUserId: "owner",
      resolveTool: () => open
    });
    expect(replay).toMatchObject({
      body: { state: "succeeded" },
      statusCode: 409
    });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(1);
  });
});
