/**
 * `muse mcp` command group, extracted from apps/cli/src/program.ts.
 *
 * Self-contained: only consumes the `apiRequest` / `writeOutput`
 * helpers (passed in as dependencies). Wraps the MCP server
 * management endpoints (list / add / connect / disconnect / tools /
 * call) in commander argument-parsing.
 *
 * Owns the local `parseJsonObject` helper for `--config` and `--args`
 * flag parsing.
 */

import type { Command } from "commander";

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
