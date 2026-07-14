import type { Command } from "commander";

/**
 * Ordered help categories for `muse --help`. With 100+ top-level commands the
 * flat alphabetical list is a wall a newcomer can't navigate; these headings
 * surface the daily-driver commands first, in a deliberate reading order. The
 * long tail (advanced / automation / integration commands) stays under
 * commander's default "Commands:" heading, which renders after the curated
 * groups. Each `commands` entry is matched against the LIVE registry in
 * applyCommandGroups, so a renamed/removed command is simply skipped — a
 * heading can never list a command that isn't actually registered.
 */
export const COMMAND_GROUPS: ReadonlyArray<{
  readonly heading: string;
  readonly commands: readonly string[];
}> = [
  { heading: "Chat & ask", commands: ["chat", "chats", "ask", "recall", "find", "search", "summarize"] },
  {
    heading: "Memory & knowledge",
    commands: [
      "remember",
      "memory",
      "forget",
      "notes",
      "note",
      "episode",
      "learned",
      "contacts",
      "skills",
      "persona",
      "reflections",
      "pattern",
      "user"
    ]
  },
  {
    heading: "Planning & time",
    commands: ["today", "continue", "thread", "week", "calendar", "remind", "tasks", "followup", "commitments", "checkins"]
  },
  {
    heading: "Setup & status",
    commands: [
      "onboard",
      "setup",
      "status",
      "doctor",
      "config",
      "config-path",
      "auth",
      "privacy",
      "trust",
      "models",
      "tui",
      "completion",
      "help",
      "export",
      "import",
      "maintenance"
    ]
  },
  {
    heading: "Automation & agents",
    commands: [
      "proactive",
      "daemon",
      "scheduler",
      "job",
      "orchestrate",
      "agents",
      "swarm",
      "objectives",
      "playbook",
      "propose",
      "approval",
      "approvals",
      "actions",
      "session",
      "watch-folder",
      "webhook",
      "routine",
      "agent-notices",
      "bg",
      "board",
      "companion-line"
    ]
  },
  {
    heading: "Connections",
    commands: ["mcp", "messaging", "inbox", "email", "feeds", "weather", "time", "web-action", "home", "voice", "listen"]
  },
  {
    heading: "Documents & analysis",
    commands: ["read", "show", "ingest", "browsing", "demo", "csv"]
  },
  {
    heading: "Reports & history",
    commands: ["brief", "recap", "history", "runs", "resume", "open", "on-this-day", "glance", "anomaly"]
  },
  {
    heading: "Diagnostics",
    commands: [
      "metrics",
      "telemetry",
      "traces",
      "trace",
      "cost",
      "tools",
      "debug",
      "runtime",
      "loopback",
      "snapshot",
      "context",
      "settings",
      "spec",
      "specs",
      "logo"
    ]
  }
];

/**
 * Assign each curated command its help-group heading and order the program's
 * command array so the headings render in COMMAND_GROUPS order. Commander 14
 * derives group order from the first appearance of each group in
 * `cmd.commands`, so reordering that array is what controls heading order;
 * dispatch is name-based, so the reorder is behaviourally safe. Ungrouped
 * commands keep the default heading and sort after every curated group.
 */
export function applyCommandGroups(program: Command): void {
  const rankByName = new Map<string, number>();
  COMMAND_GROUPS.forEach((group, index) => {
    for (const name of group.commands) {
      const command = program.commands.find((candidate) => candidate.name() === name);
      if (!command) continue;
      command.helpGroup(group.heading);
      rankByName.set(name, index);
    }
  });
  const tailRank = COMMAND_GROUPS.length;
  const orderOf = (command: Command): number => rankByName.get(command.name()) ?? tailRank;
  // commander types `.commands` readonly, but the array it backs the help
  // formatter with is mutable at runtime; an in-place sort is what reorders
  // the group headings (dispatch is name-based, so order is display-only).
  (program.commands as Command[]).sort((a, b) => orderOf(a) - orderOf(b));
}
