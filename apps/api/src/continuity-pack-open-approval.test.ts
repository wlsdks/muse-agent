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
  it("keeps preview/proposal receipt-free and opens exactly once after owner approval", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-pack-approval-"));
    const attunementFile = join(directory, "attunement.json");
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
      role: "context",
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
    const open = assembly.toolRegistry.list().find(
      (tool) => tool.definition.name === "muse.continuity.pack.open"
    )!;
    const before = await readFile(attunementFile);
    const previewed = await preview.execute(
      { threadId: thread.id },
      { runId: "preview" }
    );
    expect(previewed).toMatchObject({
      mutation: false,
      previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(await readFile(attunementFile)).toEqual(before);

    const wiring = chatWriteApprovalWiring({ env } as ServerOptions)!;
    const arguments_ = {
      previewDigest: (previewed as { readonly previewDigest: string }).previewDigest,
      threadId: thread.id
    };
    expect(CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST).toContain(open.definition.name);
    expect(wiring.toolApprovalGate({
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

    const pending = await wiring.persist("owner");
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
