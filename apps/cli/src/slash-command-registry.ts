/**
 * Single source of truth for every Muse slash command. Chat derives its
 * list from here (`slashCommandsForPlatform("chat")`) instead of keeping a
 * parallel hardcoded array, so there is exactly one definition to drift.
 */

export type CommandPlatform = "chat" | "cli" | "channel";
export type CommandCategory = "session" | "memory" | "tools" | "tasks" | "knowledge" | "info";

export interface CommandEntry {
  readonly name: string;
  readonly desc: string;
  readonly category: CommandCategory;
  readonly aliases?: readonly string[];
  readonly platforms: readonly CommandPlatform[];
  /** The real `muse <name>` command when it differs from the chat slash name; defaults to `name`. */
  readonly cliName?: string;
}

const CHAT_ONLY: readonly CommandPlatform[] = ["chat"];
const CHAT_AND_CLI: readonly CommandPlatform[] = ["chat", "cli"];

export const SLASH_COMMAND_REGISTRY: readonly CommandEntry[] = [
  { name: "help", desc: "show command help", category: "info", platforms: CHAT_ONLY },
  { name: "new", desc: "start a new conversation (the old one stays saved — see /sessions)", category: "session", platforms: CHAT_ONLY },
  { name: "clear", desc: "clear the screen (keep context)", category: "session", platforms: CHAT_ONLY },
  { name: "model", desc: "show the current model", category: "session", platforms: CHAT_ONLY },
  { name: "agents", desc: "list defined agents", category: "tools", platforms: CHAT_AND_CLI },
  { name: "agent", desc: "switch agent — /agent <name> (default to clear)", category: "tools", platforms: CHAT_ONLY },
  { name: "skills", desc: "list installed skills + how to add", category: "tools", platforms: CHAT_AND_CLI },
  { name: "today", desc: "morning briefing — tasks, calendar, weather, headlines", category: "info", platforms: CHAT_AND_CLI },
  { name: "tools", desc: "toggle tools (reads run; writes/actions ask first)", category: "tools", platforms: CHAT_ONLY },
  { name: "job", desc: "run a long task in the background — /job <prompt>", category: "tools", platforms: CHAT_ONLY },
  { name: "jobs", desc: "show recent background jobs + status", category: "tools", platforms: CHAT_ONLY },
  { name: "orchestrate", desc: "fan out to background sub-agents — /orchestrate <prompt>", category: "tools", platforms: CHAT_ONLY },
  { name: "memory", desc: "show what Muse remembers about you", category: "memory", platforms: CHAT_AND_CLI },
  { name: "remember", desc: "teach a fact — /remember <key>=<value>", category: "memory", platforms: CHAT_AND_CLI },
  { name: "pref", desc: "set a preference — /pref <key>=<value>", category: "memory", platforms: CHAT_ONLY },
  { name: "recall", desc: "search past notes + episodes — /recall <query>", category: "knowledge", platforms: CHAT_AND_CLI },
  { name: "reflect", desc: "reflect on patterns across your past sessions", category: "knowledge", platforms: CHAT_AND_CLI, cliName: "reflections" },
  { name: "forget", desc: "forget one thing — /forget <key> (or --all)", category: "memory", platforms: CHAT_AND_CLI },
  { name: "trust", desc: "show this user's trusted + blocked tools", category: "tools", platforms: CHAT_AND_CLI },
  { name: "persona", desc: "show the active persona slot", category: "tools", platforms: CHAT_AND_CLI },
  { name: "history", desc: "how many turns are in context", category: "session", platforms: CHAT_ONLY },
  { name: "sessions", desc: "list past conversations — /resume <n|id-prefix> to switch", category: "session", platforms: CHAT_ONLY },
  { name: "resume", desc: "switch the active conversation — /resume <n|id-prefix> (see /sessions)", category: "session", platforms: CHAT_ONLY },
  { name: "compact", desc: "preview compaction (no arg), or /compact <topic> to compact now, focused on that topic", category: "session", platforms: CHAT_ONLY },
  { name: "undo", desc: "roll back the last exchange — /undo <N> to roll back N (1-20)", category: "session", platforms: CHAT_ONLY },
  { name: "save", desc: "save the last reply to a note file", category: "session", platforms: CHAT_ONLY },
  { name: "copy", desc: "copy the last reply to the clipboard", category: "session", platforms: CHAT_ONLY },
  { name: "cost", desc: "show this session's token usage", category: "info", platforms: CHAT_ONLY },
  { name: "exit", desc: "quit Muse (ctrl-c)", category: "session", platforms: CHAT_ONLY }
];

/** The {cmd,desc} list a given surface exposes — derived, so there is one source. */
export function slashCommandsForPlatform(platform: CommandPlatform): readonly { readonly cmd: string; readonly desc: string }[] {
  return SLASH_COMMAND_REGISTRY
    .filter((entry) => entry.platforms.includes(platform))
    .map((entry) => ({ cmd: platform === "cli" ? (entry.cliName ?? entry.name) : entry.name, desc: entry.desc }));
}
