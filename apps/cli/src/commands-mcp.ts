/**
 * `muse mcp` command group.
 *
 * Two surfaces share this group:
 *   - API-backed subcommands (`list`, `add`, `connect`, ...) hit the
 *     running server's admin endpoints; they manage the in-process
 *     `McpServerStore` for the live runtime.
 *   - File-backed subcommands (`config-path`, `config-show`) inspect
 *     `~/.muse/mcp.json` directly; they don't need a running server,
 *     so they work during initial setup and dogfood debugging.
 */

import type { Command } from "commander";

import {
  ConfigurationError,
  loadExternalMcpConfig,
  resolveExternalMcpConfigFile
} from "@muse/autoconfigure";

import type { ProgramIO } from "./program.js";

export interface McpHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerMcpCommands(program: Command, io: ProgramIO, helpers: McpHelpers): void {
  const { apiRequest, writeOutput } = helpers;
  const mcp = program.command("mcp").description("Manage MCP servers");

  mcp
    .command("config-path")
    .description("Print the path to ~/.muse/mcp.json (Claude-Desktop-style external MCP config)")
    .action(() => {
      io.stdout(`${resolveExternalMcpConfigFile(process.env)}\n`);
    });

  mcp
    .command("config-show")
    .description("Read ~/.muse/mcp.json and print parsed entries (does not contact the server)")
    .option("--json", "Print machine-readable JSON")
    .action((options: { readonly json?: boolean }, command) => {
      const path = resolveExternalMcpConfigFile(process.env);
      let entries;
      try {
        entries = loadExternalMcpConfig(process.env);
      } catch (cause) {
        if (cause instanceof ConfigurationError) {
          io.stderr(`${cause.message}\n`);
          command.error("Invalid MCP config", { exitCode: 1 });
          return;
        }
        throw cause;
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ entries, path }, null, 2)}\n`);
        return;
      }
      io.stdout(`config: ${path}\n`);
      if (entries.length === 0) {
        io.stdout("(no entries — file is missing or has empty mcpServers)\n");
        return;
      }
      for (const entry of entries) {
        const summary = entry.transportType === "stdio"
          ? `command=${stringify(entry.config?.command)} args=${stringify(entry.config?.args)}`
          : `url=${stringify(entry.config?.url)}`;
        io.stdout(`${entry.name}\t${entry.transportType}\t${summary}\n`);
      }
    });

  mcp
    .command("list")
    .description("List MCP servers")
    .action(async (_options, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/mcp/servers"));
    });

  mcp
    .command("add")
    .description("Register an MCP server")
    .argument("<name>", "Server name")
    .requiredOption("--transport <type>", "stdio, sse, streamable, or http")
    .option("--config <json>", "Transport config JSON", "{}")
    .option("--description <text>", "Description")
    .option("--no-auto-connect", "Do not connect immediately")
    .action(async (name: string, options: { readonly autoConnect: boolean; readonly config: string; readonly description?: string; readonly transport: string }, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/mcp/servers", {
        autoConnect: options.autoConnect,
        config: parseJsonObject(options.config),
        description: options.description,
        name,
        transportType: options.transport
      }));
    });

  mcp
    .command("connect")
    .description("Connect an MCP server")
    .argument("<name>", "Server name")
    .action(async (name: string, _options, command) => {
      writeOutput(
        io,
        await apiRequest(io, command, `/api/mcp/servers/${encodeURIComponent(name)}/connect`, undefined, "POST")
      );
    });

  mcp
    .command("disconnect")
    .description("Disconnect an MCP server")
    .argument("<name>", "Server name")
    .action(async (name: string, _options, command) => {
      writeOutput(
        io,
        await apiRequest(io, command, `/api/mcp/servers/${encodeURIComponent(name)}/disconnect`, undefined, "POST")
      );
    });

  mcp
    .command("tools")
    .description("List MCP tools")
    .argument("[name]", "Optional server name")
    .action(async (name: string | undefined, _options, command) => {
      const path = name
        ? `/api/mcp/servers/${encodeURIComponent(name)}/tools`
        : "/api/mcp/tools";
      writeOutput(io, await apiRequest(io, command, path));
    });

  mcp
    .command("call")
    .description("Call a connected MCP tool")
    .argument("<server>", "Server name")
    .argument("<tool>", "Tool name")
    .option("--args <json>", "Tool arguments JSON", "{}")
    .action(async (serverName: string, toolName: string, options: { readonly args: string }, command) => {
      writeOutput(io, await apiRequest(
        io,
        command,
        `/api/mcp/servers/${encodeURIComponent(serverName)}/tools/${encodeURIComponent(toolName)}/call`,
        { args: parseJsonObject(options.args) }
      ));
    });
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "(none)";
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}
