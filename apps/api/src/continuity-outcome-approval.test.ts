import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import {
  createPersonalThread,
  openContinuityDelivery,
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

describe("normal-chat Continuity outcome approval", () => {
  it("records one explicit outcome after approval and blocks replay/overwrite", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-outcome-approval-"));
    const attunementFile = join(directory, "attunement.json");
    const pendingFile = join(directory, "pending.json");
    const thread = await createPersonalThread(attunementFile, {
      kind: "life",
      title: "Return moment"
    });
    const delivery = await openContinuityDelivery(attunementFile, {
      evidenceRefs: [],
      expectedPolicyVersion: thread.policy.version,
      threadId: thread.id
    });
    const env = {
      HOME: directory,
      MUSE_ATTUNEMENT_FILE: attunementFile,
      MUSE_CHAT_WRITE_ENABLED: "true",
      MUSE_PENDING_APPROVALS_FILE: pendingFile
    };
    const assembly = createMuseRuntimeAssembly({ env });
    const tool = assembly.toolRegistry.list().find(
      (candidate) => candidate.definition.name === "muse.continuity.delivery.outcome"
    )!;
    const wiring = chatWriteApprovalWiring({ env } as ServerOptions)!;
    const arguments_ = {
      deliveryId: delivery.id,
      outcome: "ignored",
      ownerNote: "Not useful today."
    };
    expect(CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST).toContain(tool.definition.name);
    expect(wiring.toolApprovalGate({
      risk: "write",
      runId: "proposal",
      toolCall: {
        arguments: arguments_,
        id: "call_outcome",
        name: tool.definition.name
      },
      userId: "owner"
    })).toMatchObject({ allowed: false });
    expect((await readAttunementState(attunementFile)).deliveries[0]!.outcome)
      .toBeUndefined();

    const pending = await wiring.persist("owner");
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
    expect((await readAttunementState(attunementFile)).deliveries[0]!.outcome)
      .toMatchObject({
        evidenceClass: "organic",
        outcome: "ignored",
        ownerNote: "Not useful today."
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
    expect((await readAttunementState(attunementFile)).deliveries[0]!.outcome)
      .toMatchObject({ outcome: "ignored" });
  });
});
