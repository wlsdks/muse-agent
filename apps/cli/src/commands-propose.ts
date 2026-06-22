/**
 * `muse propose` — review + confirm the state-changing actions Muse
 * has PROPOSED (draft-first). Muse never sends on its own judgement;
 * a proposal sits `pending` until you `approve` it here (which
 * executes it exactly once) or `decline` it. See `outbound-safety.md`.
 *
 *   muse propose list           — pending proposals
 *   muse propose approve <id>   — confirm + execute the draft
 *   muse propose decline <id>   — refuse it (no send)
 */

import { buildMessagingRegistry, resolveActionLogFile } from "@muse/autoconfigure";
import { isProposalActionable, readProposedActions } from "@muse/stores";
import { confirmProposedAction, declineProposedAction } from "@muse/proactivity";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface ProposeHelpers {
  readonly env?: () => NodeJS.ProcessEnv;
  readonly buildMessagingRegistry?: (env: NodeJS.ProcessEnv) => ReturnType<typeof buildMessagingRegistry>;
}

function resolveProposedActionsFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_PROPOSED_ACTIONS_FILE?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const home = env.HOME?.trim()?.length ? env.HOME.trim() : homedir();
  return join(home, ".muse", "proposed-actions.json");
}

export function registerProposeCommands(program: Command, io: ProgramIO, helpers: ProposeHelpers = {}): void {
  const env = () => helpers.env?.() ?? process.env;
  const makeMessaging = helpers.buildMessagingRegistry ?? ((e: NodeJS.ProcessEnv) => buildMessagingRegistry(e));

  const propose = program
    .command("propose")
    .description("Review + confirm the actions Muse has proposed (draft-first; nothing sends until you approve)");

  propose
    .command("list")
    .description("List proposed actions awaiting your confirmation")
    .action(async () => {
      const file = resolveProposedActionsFile(env());
      const nowAt = new Date();
      const pending = (await readProposedActions(file)).filter((p) => isProposalActionable(p, nowAt));
      if (pending.length === 0) {
        io.stdout("No proposed actions awaiting confirmation.\n");
        return;
      }
      for (const p of pending) {
        io.stdout(`${p.id}  [${p.kind} → ${p.providerId}:${p.destination}]\n  ${p.summary}\n  why: ${p.reason}\n`);
      }
    });

  propose
    .command("approve <id>")
    .description("Confirm a proposed action — executes the draft exactly once")
    .action(async (id: string) => {
      const e = env();
      const outcome = await confirmProposedAction({
        actionLogFile: resolveActionLogFile(e),
        file: resolveProposedActionsFile(e),
        id,
        registry: makeMessaging(e)
      });
      if (outcome.executed) {
        io.stdout(`Sent. (${outcome.messageId})\n`);
      } else {
        io.stderr(`Not executed: ${outcome.reason}\n`);
        process.exitCode = 1;
      }
    });

  propose
    .command("decline <id>")
    .description("Decline a proposed action — it is not sent")
    .action(async (id: string) => {
      const e = env();
      const outcome = await declineProposedAction({
        actionLogFile: resolveActionLogFile(e),
        file: resolveProposedActionsFile(e),
        id
      });
      if (outcome.declined) {
        io.stdout(`Declined ${id} — not sent.\n`);
      } else {
        io.stderr(`Not declined: ${outcome.reason ?? "unknown"}\n`);
        process.exitCode = 1;
      }
    });
}
