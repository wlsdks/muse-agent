import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import type { JsonObject } from "@muse/shared";
import { readFollowups } from "@muse/stores";
import type { MuseTool } from "@muse/tools";
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

describe("normal-chat followup management", () => {
  it("exposes list and approval-gates exact cancel and snooze mutations", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-followup-chat-management-"));
    const followupsFile = join(directory, "followups.json");
    const pendingFile = join(directory, "pending.json");
    await writeFile(followupsFile, JSON.stringify({
      followups: [
        {
          createdAt: "2026-08-09T00:00:00.000Z",
          id: "fu_cancel",
          scheduledFor: "2026-08-10T09:00:00.000Z",
          status: "scheduled",
          summary: "Cancel the budget check-in",
          userId: "owner"
        },
        {
          createdAt: "2026-08-09T00:00:00.000Z",
          id: "fu_snooze",
          scheduledFor: "2026-08-10T10:00:00.000Z",
          status: "scheduled",
          summary: "Snooze the report follow-up",
          userId: "owner"
        }
      ]
    }));
    const env = {
      HOME: directory,
      MUSE_CHAT_WRITE_ENABLED: "true",
      MUSE_FOLLOWUPS_FILE: followupsFile,
      MUSE_PENDING_APPROVALS_FILE: pendingFile
    };
    const assembly = createMuseRuntimeAssembly({ env });
    const tools = new Map(
      assembly.toolRegistry.list().map((tool) => [tool.definition.name, tool])
    );
    const list = tools.get("muse.followup.list")!;
    const cancel = tools.get("muse.followup.cancel")!;
    const snooze = tools.get("muse.followup.snooze")!;

    expect(CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST).toEqual(expect.arrayContaining([
      list.definition.name,
      cancel.definition.name,
      snooze.definition.name
    ]));
    await expect(list.execute({}, { runId: "list" })).resolves.toMatchObject({
      followups: [
        { id: "fu_cancel", status: "scheduled" },
        { id: "fu_snooze", status: "scheduled" }
      ],
      total: 2
    });

    const approve = async (
      tool: MuseTool,
      arguments_: JsonObject,
      callId: string
    ) => {
      const before = await readFile(followupsFile);
      const wiring = chatWriteApprovalWiring({ env } as ServerOptions)!;
      expect(wiring.toolApprovalGate({
        risk: "write",
        runId: callId,
        toolCall: {
          arguments: arguments_,
          id: callId,
          name: tool.definition.name
        },
        userId: "owner"
      })).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("awaiting your approval")
      });
      expect(await readFile(followupsFile)).toEqual(before);
      const pending = await wiring.persist("owner");
      expect(pending).toHaveLength(1);
      expect(await readFile(followupsFile)).toEqual(before);
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
    };

    await approve(snooze, {
      id: "fu_snooze",
      scheduledFor: "2026-08-11T10:00:00.000Z"
    }, "snooze");
    await approve(cancel, {
      id: "fu_cancel",
      reason: "owner-cancelled"
    }, "cancel");

    const followups = await readFollowups(followupsFile);
    expect(followups.find((entry) => entry.id === "fu_snooze")).toMatchObject({
      scheduledFor: "2026-08-11T10:00:00.000Z",
      status: "scheduled"
    });
    expect(followups.find((entry) => entry.id === "fu_cancel")).toMatchObject({
      cancelReason: "owner-cancelled",
      status: "cancelled"
    });
  });
});
