/**
 * `muse features` — a typed registry of user-facing capabilities that ship
 * OFF by default behind a `MUSE_*` env flag. Every gate site listed here uses
 * `parseBoolean(env.MUSE_X, false)`, so `evaluateFeatures` mirrors the exact
 * enable semantics of the real gate (empty env / falsy → off; any of
 * `true`/`1`/`yes`/`on` → on).
 *
 * Inclusion criterion: a USER-FACING capability the person can turn on to
 * unlock a new surface (a tool, a mirror, a daemon, an MCP preset). Internal
 * tuning knobs (tick intervals, file-path overrides, model-generation
 * params) and postures already surfaced by `muse doctor`
 * (`MUSE_LOCAL_ONLY`, `MUSE_WEB_EGRESS`, `MUSE_PRIVACY_ROUTING`) are
 * deliberately excluded — this registry is a discoverability surface for
 * hidden capability, not a full env-var reference. Add a new entry here
 * when a new opt-in capability ships; this is the one place it belongs.
 */

import { parseBoolean } from "@muse/autoconfigure";

export type FeatureSurface = "chat" | "memory" | "tools" | "daemon" | "mcp" | "macos";

export interface FeatureEntry {
  readonly id: string;
  readonly title: string;
  readonly unlocks: string;
  readonly envVar: string;
  readonly enableHint: string;
  readonly prerequisites?: readonly string[];
  readonly surface: FeatureSurface;
}

export const FEATURE_REGISTRY: readonly FeatureEntry[] = [
  {
    enableHint: "export MUSE_CHAT_WRITE_ENABLED=true",
    envVar: "MUSE_CHAT_WRITE_ENABLED",
    id: "chat-write",
    prerequisites: ["outbound writes still go through the draft-first approval gate — nothing auto-sends"],
    surface: "chat",
    title: "Chat write tools",
    unlocks: "Lets the direct /api/chat surface use notes/tasks/calendar/reminders write tools, captured as drafts pending your approval."
  },
  {
    enableHint: "export MUSE_EPISODIC_MEMORY_ENABLED=true",
    envVar: "MUSE_EPISODIC_MEMORY_ENABLED",
    id: "episodic-memory",
    surface: "memory",
    title: "Episodic memory capture",
    unlocks: "Auto-writes a summary of each chat/CLI session to ~/.muse/episodes.json at exit, so `muse episode` and later sessions can recall what happened."
  },
  {
    enableHint: "export MUSE_KNOWLEDGE_SEARCH_ENABLED=true",
    envVar: "MUSE_KNOWLEDGE_SEARCH_ENABLED",
    id: "knowledge-search",
    prerequisites: ["requires at least one notes provider configured"],
    surface: "tools",
    title: "Knowledge search tool",
    unlocks: "Exposes a knowledge_search tool that embeds and searches your live notes corpus per query (local Ollama embedding)."
  },
  {
    enableHint: "export MUSE_AMBIENT_ENABLED=true",
    envVar: "MUSE_AMBIENT_ENABLED",
    id: "ambient-daemon",
    prerequisites: [
      "requires a messaging provider + destination configured",
      "requires MUSE_AMBIENT_RULES to parse to at least one rule, or MUSE_AMBIENT_KNOWLEDGE_TRIGGER=true"
    ],
    surface: "daemon",
    title: "Ambient perception daemon",
    unlocks: "Reads the active-window/ambient signal each tick and edge-fires proactive notices when it matches a rule or the knowledge trigger."
  },
  {
    enableHint: "export MUSE_AMBIENT_CLIPBOARD=true",
    envVar: "MUSE_AMBIENT_CLIPBOARD",
    id: "ambient-clipboard",
    prerequisites: ["requires MUSE_AMBIENT_ENABLED=true and MUSE_AMBIENT_SOURCE=macos", "macOS only"],
    surface: "daemon",
    title: "Ambient clipboard inclusion",
    unlocks: "Includes the current clipboard contents in the live macOS ambient-perception signal (in addition to the active window title)."
  },
  {
    enableHint: "export MUSE_APPLE_NOTES_MIRROR=true",
    envVar: "MUSE_APPLE_NOTES_MIRROR",
    id: "apple-notes-mirror",
    prerequisites: ["macOS only"],
    surface: "macos",
    title: "Apple Notes mirror",
    unlocks: "One-way create-only mirror of new Muse notes into Notes.app, so they're visible across your Apple devices."
  },
  {
    enableHint: "export MUSE_APPLE_REMINDERS_MIRROR=true",
    envVar: "MUSE_APPLE_REMINDERS_MIRROR",
    id: "apple-reminders-mirror",
    prerequisites: ["macOS only"],
    surface: "macos",
    title: "Apple Reminders mirror",
    unlocks: "One-way mirror of new Muse reminders into Reminders.app, so they're visible on your iPhone/Watch."
  },
  {
    enableHint: "export MUSE_GITHUB_MCP_ENABLED=true",
    envVar: "MUSE_GITHUB_MCP_ENABLED",
    id: "github-mcp",
    prerequisites: ["requires GITHUB_MCP_TOKEN or a credential in ~/.muse/mcp-credentials.json — a bare toggle with no resolvable credential does NOT enable the preset"],
    surface: "mcp",
    title: "GitHub MCP preset",
    unlocks: "Auto-registers the curated GitHub remote MCP server so you don't hand-write it in mcp.json."
  },
  {
    enableHint: "export MUSE_NOTION_MCP_ENABLED=true",
    envVar: "MUSE_NOTION_MCP_ENABLED",
    id: "notion-mcp",
    prerequisites: ["requires NOTION_MCP_TOKEN or a credential in ~/.muse/mcp-credentials.json — a bare toggle with no resolvable credential does NOT enable the preset"],
    surface: "mcp",
    title: "Notion MCP preset",
    unlocks: "Auto-registers the curated Notion remote MCP server so you don't hand-write it in mcp.json."
  },
  {
    enableHint: "export MUSE_CHROME_DEVTOOLS_ENABLED=true",
    envVar: "MUSE_CHROME_DEVTOOLS_ENABLED",
    id: "chrome-devtools-mcp",
    surface: "mcp",
    title: "Chrome DevTools MCP preset",
    unlocks: "Auto-registers the Chrome DevTools MCP server (auto-connect) so you don't hand-write the npx command + --browser-url in mcp.json."
  },
  {
    enableHint: "export MUSE_MACOS_ACTUATORS=true",
    envVar: "MUSE_MACOS_ACTUATORS",
    id: "macos-actuators",
    prerequisites: ["macOS only"],
    surface: "macos",
    title: "macOS actuator tools",
    unlocks: "Arms the mac_* actuator tools (Shortcuts-backed system control: focus/DND, bluetooth, brightness, and more)."
  }
];

export interface FeatureStatus {
  readonly entry: FeatureEntry;
  readonly enabled: boolean;
}

export function evaluateFeatures(env: Record<string, string | undefined>): readonly FeatureStatus[] {
  return FEATURE_REGISTRY.map((entry) => ({
    enabled: parseBoolean(env[entry.envVar], false),
    entry
  }));
}
