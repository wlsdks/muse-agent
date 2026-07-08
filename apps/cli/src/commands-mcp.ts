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

import { mkdirSync as nodeMkdirSync, readFileSync as nodeReadFileSync, writeFileSync as nodeWriteFileSync } from "node:fs";
import { dirname as nodePathDirname } from "node:path";

import type { Command } from "commander";

import {
  ConfigurationError,
  diagnoseExternalMcpConfigFile,
  loadExternalMcpConfig,
  resolveExternalMcpConfigFile
} from "@muse/autoconfigure";

import { closestCommandName } from "./closest-command.js";
import { firstNonEmpty } from "./program-helpers.js";
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
  mcp.addHelpText("after", `
Examples:
  $ muse mcp add filesystem --transport stdio --config '{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}'
  $ muse mcp call filesystem read_file --args '{"path":"/tmp/notes.txt"}'   # invoke a connected tool
  $ muse mcp config-doctor                                                  # validate every entry in ~/.muse/mcp.json`);

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
        io.stdout(`${JSON.stringify({ entries, path, total: entries.length }, null, 2)}\n`);
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
    .command("config-doctor")
    .description("Validate every entry in ~/.muse/mcp.json and report findings (per-entry, no bail on first error)")
    .option("--json", "Print machine-readable JSON")
    .action((options: { readonly json?: boolean }, command) => {
      const path = resolveExternalMcpConfigFile(process.env);
      let diagnoses;
      try {
        diagnoses = diagnoseExternalMcpConfigFile(process.env);
      } catch (cause) {
        if (cause instanceof ConfigurationError) {
          io.stderr(`${cause.message}\n`);
          command.error("MCP config has a top-level error (e.g. malformed JSON)", { exitCode: 1 });
          return;
        }
        throw cause;
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ diagnoses, path }, null, 2)}\n`);
        return;
      }
      io.stdout(`config: ${path}\n`);
      if (diagnoses.length === 0) {
        io.stdout("(no entries — file is missing or has empty mcpServers)\n");
        return;
      }
      let errorCount = 0;
      for (const diagnosis of diagnoses) {
        if (diagnosis.status === "error") {
          errorCount += 1;
        }
        const transport = diagnosis.transportType ?? "?";
        const findings = diagnosis.findings.length > 0
          ? diagnosis.findings.join("; ")
          : "no issues";
        io.stdout(`${diagnosis.name}\t${diagnosis.status.toUpperCase()}\t${transport}\t${findings}\n`);
      }
      if (errorCount > 0) {
        command.error(`${errorCount} of ${diagnoses.length} entries had errors`, { exitCode: 1 });
      }
    });

  mcp
    .command("config-add")
    .description("Add an entry to ~/.muse/mcp.json from CLI flags (does not contact the server)")
    .argument("<name>", "Server name (must be unique within the config)")
    .option("--transport <type>", "stdio | streamable | sse (defaults: stdio if --command set, streamable if --url set)")
    .option("--command <cmd>", "stdio: launch command (e.g. npx)")
    .option("--arg <arg...>", "stdio: launch arg (repeatable)", collectAppend, [])
    .option("--cwd <dir>", "stdio: working directory")
    .option("--env <KEY=VALUE...>", "stdio: env var (repeatable)", collectAppend, [])
    .option("--url <url>", "streamable/sse: server URL")
    .option("--header <KEY=VALUE...>", "streamable/sse: HTTP header (repeatable)", collectAppend, [])
    .option("--description <text>", "Optional description")
    .option("--disabled", "Mark the entry as disabled (will be skipped on boot)")
    .option("--dry-run", "Print the merged JSON without writing the file")
    .action((name: string, options: ConfigAddOptions, command) => {
      const path = resolveExternalMcpConfigFile(process.env);
      let entry: McpJsonEntry;
      try {
        entry = buildEntryFromOptions(name, options);
      } catch (cause) {
        io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        command.error("Invalid arguments", { exitCode: 1 });
        return;
      }
      const merged = mergeEntryIntoConfigFile(path, name, entry, command, io);
      if (!merged) {
        return;
      }
      if (options.dryRun) {
        io.stdout(`${JSON.stringify(merged, null, 2)}\n`);
        return;
      }
      writeMcpConfigFile(path, merged);
      io.stdout(`added ${name} (${entry.command ? "stdio" : (options.transport ?? "streamable")}) → ${path}\n`);
    });

  mcp
    .command("use")
    .description("Add a popular MCP server from a preset (one-line shortcut over config-add)")
    .argument("<preset>", `Preset name (${Object.keys(MCP_PRESETS).join(" / ")})`)
    .option("--root <dir>", "filesystem preset: root directory (defaults to $HOME)")
    .option("--name <alias>", "Alias for the entry (default: preset name)")
    .option("--dry-run", "Print the merged JSON without writing the file")
    .action((preset: string, options: McpUseOptions, command) => {
      const recipe = MCP_PRESETS[preset.toLowerCase()];
      if (!recipe) {
        const suggestion = closestCommandName(preset, Object.keys(MCP_PRESETS));
        const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
        io.stderr(
          `Unknown preset '${preset}'${hint}. Available: ${Object.keys(MCP_PRESETS).join(", ")}\n`
        );
        command.error("Unknown MCP preset", { exitCode: 1 });
        return;
      }
      const entryName = options.name ?? recipe.defaultName;
      const entry = recipe.build(options);
      const path = resolveExternalMcpConfigFile(process.env);
      const merged = mergeEntryIntoConfigFile(path, entryName, entry, command, io);
      if (!merged) {
        return;
      }
      if (options.dryRun) {
        io.stdout(`${JSON.stringify(merged, null, 2)}\n`);
        return;
      }
      writeMcpConfigFile(path, merged);
      io.stdout(`added ${entryName} (preset=${preset}) → ${path}\n`);
    });

  mcp
    .command("serve")
    .description(
      "Run Muse itself as a local read-only MCP server over stdio, for another agent (Claude Code, Cursor, Codex, ...) " +
      "to connect to — muse_recall (cited grounded Q&A), knowledge_search (ranked search over your notes + remembered " +
      "facts/preferences), and user_model_read (your facts/preferences with confidence). Local-only, no network listener; " +
      "nothing here writes or changes anything. Running this command is your explicit consent to expose these read tools " +
      "to the connecting client. Add to Claude Code: `claude mcp add muse -- muse mcp serve`."
    )
    .action(async () => {
      const { runMcpServeCommand } = await import("./commands-mcp-serve.js");
      await runMcpServeCommand(io);
    });

  mcp
    .command("list")
    .description("List MCP servers")
    .action(async (_options, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/mcp/servers"));
    });

  // Render "reconnecting in 8s" so an operator doesn't stare at
  // "disconnected" unsure whether a retry is still scheduled.
  mcp
    .command("status")
    .description("Show per-server health, including reconnect schedule")
    .option("--json", "Print the raw health payload from /api/mcp/servers/:name/health")
    .action(async (options: { readonly json?: boolean }, command) => {
      const servers = (await apiRequest(io, command, "/api/mcp/servers")) as Array<{ name: string }>;
      if (!Array.isArray(servers) || servers.length === 0) {
        io.stdout("(no MCP servers registered)\n");
        return;
      }
      const now = Date.now();
      const rows: Array<Record<string, unknown>> = [];
      for (const server of servers) {
        const health = await apiRequest(io, command, `/api/mcp/servers/${encodeURIComponent(server.name)}/health`) as {
          status?: string;
          error?: string;
          reconnectAttempts?: number;
          nextReconnectAt?: string;
        };
        rows.push({ name: server.name, ...health });
      }
      if (options.json) {
        writeOutput(io, rows);
        return;
      }
      for (const row of rows) {
        const status = String(row["status"] ?? "?");
        const attempts = Number(row["reconnectAttempts"] ?? 0);
        const nextAt = row["nextReconnectAt"] ? new Date(String(row["nextReconnectAt"])) : undefined;
        let reconnectClause = "";
        if (nextAt && !Number.isNaN(nextAt.getTime())) {
          const seconds = Math.max(0, Math.round((nextAt.getTime() - now) / 1000));
          reconnectClause = ` (reconnecting in ${seconds.toString()}s, attempt ${attempts.toString()})`;
        }
        const errorClause = row["error"] ? ` — ${String(row["error"])}` : "";
        io.stdout(`${String(row["name"])}\t${status.toUpperCase()}${reconnectClause}${errorClause}\n`);
      }
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

interface ConfigAddOptions {
  readonly transport?: "stdio" | "streamable" | "sse" | string;
  readonly command?: string;
  readonly arg?: readonly string[];
  readonly cwd?: string;
  readonly env?: readonly string[];
  readonly url?: string;
  readonly header?: readonly string[];
  readonly description?: string;
  readonly disabled?: boolean;
  readonly dryRun?: boolean;
}

interface McpJsonEntry {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly url?: string;
  readonly transport?: "streamable" | "sse";
  readonly headers?: Record<string, string>;
  readonly description?: string;
  readonly disabled?: boolean;
}

function collectAppend(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function buildEntryFromOptions(name: string, options: ConfigAddOptions): McpJsonEntry {
  if (!name || name.trim().length === 0) {
    throw new Error("server name is required");
  }
  const transport = options.transport
    ?? (options.command ? "stdio" : options.url ? "streamable" : undefined);
  if (!transport) {
    throw new Error("specify either --command (stdio) or --url (streamable/sse)");
  }
  if (transport === "stdio") {
    if (!options.command || options.command.trim().length === 0) {
      throw new Error("stdio entries require --command");
    }
    const env = parseKeyValuePairs(options.env, "--env");
    return {
      command: options.command,
      ...(options.arg && options.arg.length > 0 ? { args: [...options.arg] } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(env ? { env } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.disabled ? { disabled: true } : {})
    };
  }
  if (transport !== "streamable" && transport !== "sse") {
    const suggestion = closestCommandName(transport, ["stdio", "streamable", "sse"]);
    const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
    throw new Error(`--transport must be 'stdio', 'streamable', or 'sse' (got '${transport}')${hint}`);
  }
  if (!options.url || options.url.trim().length === 0) {
    throw new Error(`${transport} entries require --url`);
  }
  const headers = parseKeyValuePairs(options.header, "--header");
  return {
    url: options.url,
    transport,
    ...(headers ? { headers } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.disabled ? { disabled: true } : {})
  };
}

function parseKeyValuePairs(
  pairs: readonly string[] | undefined,
  flag: string
): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const raw of pairs) {
    const equals = raw.indexOf("=");
    if (equals <= 0) {
      throw new Error(`${flag} entries must be KEY=VALUE (got ${JSON.stringify(raw)})`);
    }
    const key = raw.slice(0, equals).trim();
    const value = raw.slice(equals + 1);
    if (key.length === 0) {
      throw new Error(`${flag} key must be non-empty (got ${JSON.stringify(raw)})`);
    }
    out[key] = value;
  }
  return out;
}

interface McpConfigShape {
  mcpServers?: Record<string, McpJsonEntry>;
  [key: string]: unknown;
}

function mergeEntryIntoConfigFile(
  path: string,
  name: string,
  entry: McpJsonEntry,
  command: Command,
  io: ProgramIO
): McpConfigShape | undefined {
  const existing = readMcpConfigFile(path);
  if (existing && existing.mcpServers && Object.prototype.hasOwnProperty.call(existing.mcpServers, name)) {
    io.stderr(`entry '${name}' already exists in ${path} — pick a different name or remove it first\n`);
    command.error("Duplicate entry", { exitCode: 1 });
    return undefined;
  }
  const base = existing ?? {};
  const servers = base.mcpServers ?? {};
  return {
    ...base,
    mcpServers: { ...servers, [name]: entry }
  };
}

function readMcpConfigFile(path: string): McpConfigShape | undefined {
  let raw: string;
  try {
    raw = nodeReadFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw cause;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`MCP config at ${path} is not a JSON object`);
  }
  return parsed as McpConfigShape;
}

function writeMcpConfigFile(path: string, value: McpConfigShape): void {
  const dir = nodePathDirname(path);
  nodeMkdirSync(dir, { recursive: true });
  nodeWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface McpUseOptions {
  readonly root?: string;
  readonly name?: string;
  readonly dryRun?: boolean;
}

interface McpPresetRecipe {
  readonly defaultName: string;
  readonly build: (options: McpUseOptions) => McpJsonEntry;
}

export const MCP_PRESETS: Record<string, McpPresetRecipe> = {
  filesystem: {
    defaultName: "filesystem",
    build: (options): McpJsonEntry => {
      const root = firstNonEmpty(options.root, process.env.HOME);
      if (!root) {
        throw new Error("muse mcp use filesystem: --root <dir> is required (HOME is empty / unset, refusing to default to filesystem root)");
      }
      return {
        args: ["-y", "@modelcontextprotocol/server-filesystem", root],
        command: "npx",
        description: `Filesystem read/write rooted at ${root}`
      };
    }
  },
  fetch: {
    defaultName: "fetch",
    build: (): McpJsonEntry => ({
      args: ["mcp-server-fetch"],
      command: "uvx",
      description: "Generic HTTP fetcher (requires uvx; pipx install uv)"
    })
  },
  time: {
    defaultName: "time",
    build: (): McpJsonEntry => ({
      args: ["mcp-server-time"],
      command: "uvx",
      description: "Timezone-aware date/time queries"
    })
  },
  sqlite: {
    defaultName: "sqlite",
    build: (options): McpJsonEntry => ({
      args: ["-y", "@modelcontextprotocol/server-sqlite", options.root ?? "./data.db"],
      command: "npx",
      description: `SQLite over ${options.root ?? "./data.db"}`
    })
  },
  memory: {
    defaultName: "memory",
    build: (): McpJsonEntry => ({
      args: ["-y", "@modelcontextprotocol/server-memory"],
      command: "npx",
      description: "Anthropic reference memory server (knowledge graph)"
    })
  }
};
