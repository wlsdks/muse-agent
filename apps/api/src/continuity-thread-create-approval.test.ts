import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { readAttunementState } from "@muse/attunement";
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

describe("normal-chat continuity thread proposal approval", () => {
  it("keeps thread/kind/link persistence at zero until exact approval and blocks replay", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-approval-"));
    const attunementFile = join(directory, "attunement.json");
    const pendingFile = join(directory, "pending.json");
    const env = {
      HOME: directory,
      MUSE_ATTUNEMENT_FILE: attunementFile,
      MUSE_CHAT_WRITE_ENABLED: "true",
      MUSE_PENDING_APPROVALS_FILE: pendingFile
    };
    const assembly = createMuseRuntimeAssembly({ env });
    const tool = assembly.toolRegistry.list().find(
      (candidate) => candidate.definition.name === "muse.continuity.thread.create"
    )!;
    const wiring = chatWriteApprovalWiring({ env } as ServerOptions)!;
    const proposal = {
      kind: "life",
      title: "Return to a sustainable sleep routine"
    };

    expect(CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST).toContain(tool.definition.name);
    expect(wiring.toolApprovalGate({
      risk: "write",
      runId: "proposal_1",
      toolCall: {
        arguments: proposal,
        id: "call_1",
        name: tool.definition.name
      },
      userId: "owner"
    })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("awaiting your approval")
    });

    expect(wiring.drafts).toHaveLength(1);
    await expect(access(attunementFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readAttunementState(attunementFile)).threads).toEqual([]);

    const pending = await wiring.persist("owner");
    expect(pending).toHaveLength(1);
    await expect(access(attunementFile)).rejects.toMatchObject({ code: "ENOENT" });

    const approved = await executeChatApproval({
      id: pending[0]!.id,
      pendingFile,
      requestUserId: "owner",
      resolveTool: (name) => name === tool.definition.name ? tool : undefined
    });
    expect(approved).toMatchObject({
      body: { ran: true, state: "succeeded", tool: tool.definition.name },
      statusCode: 200
    });
    const afterApproval = await readAttunementState(attunementFile);
    expect(afterApproval.threads).toHaveLength(1);
    expect(afterApproval.threads[0]).toMatchObject({
      kind: proposal.kind,
      links: [],
      title: proposal.title
    });

    const replay = await executeChatApproval({
      id: pending[0]!.id,
      pendingFile,
      requestUserId: "owner",
      resolveTool: () => tool
    });
    expect(replay).toMatchObject({
      body: { state: "succeeded" },
      statusCode: 409
    });
    expect((await readAttunementState(attunementFile)).threads).toHaveLength(1);
  });
});
