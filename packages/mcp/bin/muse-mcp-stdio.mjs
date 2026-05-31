#!/usr/bin/env node
/**
 * Muse → stdio MCP server bridge.
 *
 * Wraps one of Muse's internal `LoopbackMcpServer`s
 * (`muse.notes` / `muse.tasks` / `muse.calendar` / `muse.reminders`
 * / `muse.proactive`) as an MCP server that speaks JSON-RPC over
 * stdio, so external MCP clients (Codex, Claude Desktop, etc.) can
 * register Muse tools alongside their own.
 *
 * Usage:
 *   muse-mcp-stdio notes
 *   muse-mcp-stdio tasks
 *   muse-mcp-stdio calendar      # local file backend
 *   muse-mcp-stdio reminders
 *   muse-mcp-stdio proactive
 *
 * Registering with Codex:
 *   codex mcp add muse-notes -- node /abs/path/to/Muse/packages/mcp/bin/muse-mcp-stdio.mjs notes
 *   codex mcp add muse-tasks -- node /abs/path/to/Muse/packages/mcp/bin/muse-mcp-stdio.mjs tasks
 *
 * Env paths match `~/.muse/` defaults the API server uses:
 *   notes      → MUSE_NOTES_DIR             default ~/.muse/notes/
 *   tasks      → MUSE_TASKS_FILE             default ~/.muse/tasks.json
 *   calendar   → MUSE_CALENDAR_FILE          default ~/.muse/calendar.json (local file backend)
 *   reminders  → MUSE_REMINDERS_FILE         default ~/.muse/reminders.json
 *   history    → MUSE_REMINDER_HISTORY_FILE  default ~/.muse/reminder-history.json
 *   proactive  → MUSE_PROACTIVE_HISTORY_FILE default ~/.muse/proactive-history.json
 */

import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import process from "node:process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import {
  createCalendarMcpServer,
  createNotesMcpServer,
  createProactiveMcpServer,
  createRemindersMcpServer,
  createStatusMcpServer,
  createTasksMcpServer
} from "../dist/index.js";
import { CalendarProviderRegistry, LocalCalendarProvider } from "@muse/calendar";

const which = (process.argv[2] ?? "").trim().toLowerCase();
if (!which) {
  process.stderr.write(
    "usage: muse-mcp-stdio <notes|tasks|calendar|reminders|proactive|status>\n"
  );
  process.exit(2);
}

const env = process.env;
const home = homedir();
const dot = (envKey, name) => {
  const v = env[envKey]?.trim();
  return v && v.length > 0 ? v : pathJoin(home, ".muse", name);
};

let loopback;
switch (which) {
  case "notes":
    loopback = createNotesMcpServer({ notesDir: dot("MUSE_NOTES_DIR", "notes") });
    break;
  case "tasks":
    loopback = createTasksMcpServer({ file: dot("MUSE_TASKS_FILE", "tasks.json") });
    break;
  case "calendar": {
    const registry = new CalendarProviderRegistry();
    registry.register(new LocalCalendarProvider({ file: dot("MUSE_CALENDAR_FILE", "calendar.json") }));
    loopback = createCalendarMcpServer({ registry });
    break;
  }
  case "reminders":
    loopback = createRemindersMcpServer({
      file: dot("MUSE_REMINDERS_FILE", "reminders.json"),
      historyFile: dot("MUSE_REMINDER_HISTORY_FILE", "reminder-history.json")
    });
    break;
  case "proactive":
    loopback = createProactiveMcpServer({
      historyFile: dot("MUSE_PROACTIVE_HISTORY_FILE", "proactive-history.json")
    });
    break;
  case "status":
    loopback = createStatusMcpServer({
      userMemoryFile: dot("MUSE_USER_MEMORY_FILE", "user-memory.json"),
      tasksFile: dot("MUSE_TASKS_FILE", "tasks.json"),
      historyFile: dot("MUSE_PROACTIVE_HISTORY_FILE", "proactive-history.json"),
      logFile: dot("MUSE_MESSAGING_LOG_FILE", "notifications.log"),
      trustFile: dot("MUSE_TRUST_FILE", "trust.json")
    });
    break;
  default:
    process.stderr.write(`muse-mcp-stdio: unknown server '${which}'.\n`);
    process.exit(2);
}

const toolsByName = new Map(loopback.tools.map((tool) => [tool.name, tool]));

const server = new Server(
  {
    name: loopback.name,
    version: "0.0.0"
  },
  {
    capabilities: { tools: {} }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: loopback.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = toolsByName.get(request.params.name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
      isError: true
    };
  }
  try {
    const result = await tool.execute((request.params.arguments ?? {}));
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      content: [{ type: "text", text: `tool '${request.params.name}' failed: ${message}` }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
