import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { createPersonalThread, readAttunementState } from "@muse/attunement";
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

describe("normal-chat continuity exact task link approval", () => {
  it("keeps preview/proposal mutation-free and executes the exact link once after owner approval", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-task-approval-"));
    const attunementFile = join(directory, "attunement.json");
    const pendingFile = join(directory, "pending.json");
    const tasksFile = join(directory, "tasks.json");
    const thread = await createPersonalThread(attunementFile, {
      kind: "life",
      title: "Health routine"
    });
    await writeFile(tasksFile, JSON.stringify({
      tasks: [{
        createdAt: "2026-07-28T00:00:00.000Z",
        id: "task_sleep",
        status: "open",
        title: "Set a stable bedtime"
      }]
    }));
    const env = {
      HOME: directory,
      MUSE_ATTUNEMENT_FILE: attunementFile,
      MUSE_CHAT_WRITE_ENABLED: "true",
      MUSE_PENDING_APPROVALS_FILE: pendingFile,
      MUSE_TASKS_FILE: tasksFile
    };
    const assembly = createMuseRuntimeAssembly({ env });
    const preview = assembly.toolRegistry.list().find(
      (tool) => tool.definition.name === "muse.continuity.task.link.preview"
    )!;
    const link = assembly.toolRegistry.list().find(
      (tool) => tool.definition.name === "muse.continuity.task.link"
    )!;
    const proposal = {
      expectedTitle: "Set a stable bedtime",
      role: "context",
      taskId: "task_sleep",
      threadId: thread.id
    };
    const before = await readFile(attunementFile);
    const previewed = await preview.execute(proposal, { runId: "preview" });
    expect(previewed).toMatchObject({
      mutation: false,
      previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(await readFile(attunementFile)).toEqual(before);

    const wiring = chatWriteApprovalWiring({ env } as ServerOptions)!;
    const confirmed = {
      ...proposal,
      previewDigest: (previewed as { readonly previewDigest: string }).previewDigest
    };
    expect(CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST).toContain(link.definition.name);
    expect(wiring.toolApprovalGate({
      risk: "write",
      runId: "proposal",
      toolCall: {
        arguments: confirmed,
        id: "call_link",
        name: link.definition.name
      },
      userId: "owner"
    })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("awaiting your approval")
    });
    expect(await readFile(attunementFile)).toEqual(before);

    const pending = await wiring.persist("owner");
    expect(pending).toHaveLength(1);
    expect(await readFile(attunementFile)).toEqual(before);
    const approved = await executeChatApproval({
      id: pending[0]!.id,
      pendingFile,
      requestUserId: "owner",
      resolveTool: (name) => name === link.definition.name ? link : undefined
    });
    expect(approved).toMatchObject({
      body: { ran: true, state: "succeeded", tool: link.definition.name },
      statusCode: 200
    });
    expect((await readAttunementState(attunementFile)).threads[0]!.links)
      .toHaveLength(1);

    const replay = await executeChatApproval({
      id: pending[0]!.id,
      pendingFile,
      requestUserId: "owner",
      resolveTool: () => link
    });
    expect(replay).toMatchObject({
      body: { state: "succeeded" },
      statusCode: 409
    });
    expect((await readAttunementState(attunementFile)).threads[0]!.links)
      .toHaveLength(1);
  });
});
