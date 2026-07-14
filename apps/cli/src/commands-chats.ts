/**
 * `muse chats` command group — visibility + control over past conversations
 * (`~/.muse/conversations.json`, via chat-history.ts's active-conversation
 * pointer). Each past chat (the Ink REPL or a one-shot `--continue` run) is
 * now an ADDRESSABLE unit: list them, switch which one `muse chat -i` /
 * `--continue` resumes, rename, or drop one.
 *
 *   - `muse chats` / `muse chats list`         — numbered list, newest first
 *   - `muse chats resume <id|prefix>`          — switch the active conversation
 *   - `muse chats rename <id|prefix> <title>`  — rename one
 *   - `muse chats delete <id|prefix> [--yes]`  — drop one (irreversible)
 *
 * `id|prefix` resolution is the SAME fail-close rule everywhere here: an
 * exact id always wins, an unambiguous prefix resolves, and an ambiguous
 * prefix refuses (lists every candidate) rather than acting on a guess.
 */

import type { Command } from "commander";
import type { ConversationSummary } from "@muse/stores";

import {
  activeConversationId,
  deleteConversation,
  listConversations,
  renameConversation,
  resumeConversation
} from "./chat-history.js";
import { formatRelativeTime } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

interface SharedOptions {
  readonly json?: boolean;
}

/** Pretty-print the conversation list (pure; exported for tests). */
export function formatConversationList(
  summaries: readonly ConversationSummary[],
  activeId: string | undefined,
  now: Date = new Date()
): string {
  if (summaries.length === 0) {
    return "No conversations yet — start one with `muse chat -i`.\n";
  }
  const lines = summaries.map((c, index) => {
    const marker = c.id === activeId ? " (active)" : "";
    // The id is already short (conv_ + 8 hex) — shown in full, unlike the
    // longer UUID-based episode/task ids elsewhere which get truncated.
    const turns = c.turnCount === 1 ? "1 turn" : `${c.turnCount.toString()} turns`;
    return `${(index + 1).toString()}. [${c.id}]${marker} ${c.title} — ${turns}, updated ${formatRelativeTime(c.updatedAt, now)}`;
  });
  return `${lines.join("\n")}\n`;
}

export function registerChatsCommands(program: Command, io: ProgramIO): void {
  const chats = program
    .command("chats")
    .description("List, resume, rename, or delete past conversations (muse chat -i / --continue)");

  chats
    .command("list", { isDefault: true })
    .description("List conversations, newest first (numbered; marks the active one)")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: SharedOptions) => {
      const [summaries, activeId] = await Promise.all([listConversations(), activeConversationId()]);
      if (options.json) {
        io.stdout(`${JSON.stringify({ activeId, conversations: summaries, total: summaries.length }, null, 2)}\n`);
        return;
      }
      io.stdout(formatConversationList(summaries, activeId));
    });

  chats
    .command("resume")
    .description("Set the active conversation — the next `muse chat -i` / `muse chat --continue` picks it up")
    .argument("<id>", "Conversation id or unambiguous prefix (see `muse chats list`)")
    .option("--json", "Print { resumed, id, title } on success")
    .action(async (ref: string, options: SharedOptions) => {
      const resolution = await resumeConversation(ref);
      if (resolution.status === "not-found") {
        throw new Error(`No conversation found with id "${ref}". Run 'muse chats' to see the list.`);
      }
      if (resolution.status === "ambiguous") {
        const previews = resolution.candidates.map((c) => `${c.id} (${c.title})`).join(", ");
        throw new Error(`Ambiguous conversation id "${ref}" — matches ${resolution.candidates.length.toString()}: ${previews}`);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ id: resolution.summary.id, resumed: true, title: resolution.summary.title }, null, 2)}\n`);
        return;
      }
      io.stdout(`Resumed "${resolution.summary.title}" [${resolution.summary.id}] — the next chat picks it up.\n`);
    });

  chats
    .command("rename")
    .description("Rename a conversation")
    .argument("<id>", "Conversation id or unambiguous prefix")
    .argument("<title...>", "New title (joined by spaces)")
    .option("--json", "Print { renamed, id, title } on success")
    .action(async (id: string, titleParts: readonly string[], options: SharedOptions) => {
      const title = titleParts.join(" ").trim();
      if (title.length === 0) {
        throw new Error("title is required");
      }
      const resolvedId = await resolveConversationIdOrThrow(id, "rename");
      const ok = await renameConversation(resolvedId, title);
      if (!ok) {
        throw new Error(`No conversation found with id "${id}". Run 'muse chats' to see the list.`);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ id: resolvedId, renamed: true, title }, null, 2)}\n`);
        return;
      }
      io.stdout(`Renamed [${resolvedId}] → "${title}"\n`);
    });

  chats
    .command("delete")
    .description("Delete a conversation (irreversible — requires --yes)")
    .argument("<id>", "Conversation id or unambiguous prefix")
    .option("--yes", "Confirm destructive intent. Without this flag the command refuses.")
    .option("--json", "Print { deleted, id, activeId } on success")
    .action(async (id: string, options: { readonly yes?: boolean } & SharedOptions) => {
      if (!options.yes) {
        throw new Error("Refusing to delete without --yes (this is irreversible — pass --yes to confirm)");
      }
      const resolvedId = await resolveConversationIdOrThrow(id, "delete");
      const result = await deleteConversation(resolvedId);
      if (!result.deleted) {
        throw new Error(`No conversation found with id "${id}". Run 'muse chats' to see the list.`);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ activeId: result.activeId, deleted: true, id: resolvedId }, null, 2)}\n`);
        return;
      }
      io.stdout(`Deleted [${resolvedId}]. Active conversation is now [${result.activeId}].\n`);
    });
}

/** Resolve an id-or-prefix against the live list, or throw a fail-close error naming what went wrong. */
async function resolveConversationIdOrThrow(ref: string, verb: string): Promise<string> {
  const { resolveConversationRef } = await import("@muse/stores");
  const summaries = await listConversations();
  const resolution = resolveConversationRef(summaries, ref);
  if (resolution.status === "resolved") {
    return resolution.summary.id;
  }
  if (resolution.status === "ambiguous") {
    const previews = resolution.candidates.map((c) => `${c.id} (${c.title})`).join(", ");
    throw new Error(`Ambiguous conversation id "${ref}" — matches ${resolution.candidates.length.toString()}: ${previews}`);
  }
  throw new Error(`No conversation found with id "${ref}" to ${verb}. Run 'muse chats' to see the list.`);
}
