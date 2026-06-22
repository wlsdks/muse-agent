import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { proposeMessageAction, readProposedActions } from "@muse/stores";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerProposeCommands } from "./commands-propose.js";

function capturing(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

function env(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "muse-propose-cli-"));
  return { MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"), MUSE_PROPOSED_ACTIONS_FILE: join(dir, "proposed.json") };
}

async function run(args: string[], opts: { env: NodeJS.ProcessEnv; registry: MessagingProviderRegistry }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prevExit = process.exitCode;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerProposeCommands(program, io, { buildMessagingRegistry: () => opts.registry, env: () => opts.env });
    await program.parseAsync(["node", "muse", "propose", ...args]);
    exitCode = process.exitCode === undefined ? undefined : Number(process.exitCode);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    process.exitCode = prevExit;
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

const draft = {
  destination: "555",
  providerId: "telegram",
  reason: "calendar conflict — proposed a reschedule note",
  summary: "Tell Sam standup moves to 10am",
  text: "Heads up — standup moves to 10am tomorrow.",
  userId: "stark"
} as const;

describe("muse propose — review + confirm proposed actions (draft-first)", () => {
  it("list shows a pending proposal without sending anything", async () => {
    const e = env();
    const proposal = await proposeMessageAction(e.MUSE_PROPOSED_ACTIONS_FILE!, draft);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturing(sent)]);

    const res = await run(["list"], { env: e, registry });

    expect(res.stdout).toContain(proposal.id);
    expect(res.stdout).toContain("Tell Sam standup moves to 10am");
    expect(sent).toHaveLength(0);
  });

  it("approve executes the draft once and sends it to the channel", async () => {
    const e = env();
    const proposal = await proposeMessageAction(e.MUSE_PROPOSED_ACTIONS_FILE!, draft);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturing(sent)]);

    const res = await run(["approve", proposal.id], { env: e, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("Sent.");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("standup moves to 10am");
    expect((await readProposedActions(e.MUSE_PROPOSED_ACTIONS_FILE!))[0]!.status).toBe("executed");

    // re-approve is a no-op (replay guard)
    const again = await run(["approve", proposal.id], { env: e, registry });
    expect(again.exitCode).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("decline refuses without sending", async () => {
    const e = env();
    const proposal = await proposeMessageAction(e.MUSE_PROPOSED_ACTIONS_FILE!, draft);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturing(sent)]);

    const res = await run(["decline", proposal.id], { env: e, registry });

    expect(res.stdout).toContain("Declined");
    expect(sent).toHaveLength(0);
    expect((await readProposedActions(e.MUSE_PROPOSED_ACTIONS_FILE!))[0]!.status).toBe("declined");
  });
});
