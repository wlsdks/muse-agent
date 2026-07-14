/**
 * `/api/notes/*` routes — REST surface for the personal notes file
 * store, the REST counterpart to the `muse tasks` and `muse calendar`
 * stores.
 *
 * Backed by the existing `createNotesMcpServer({ notesDir })` so the
 * REST surface is byte-identical to the MCP tool surface and shares
 * the same path-safety / size-cap logic. The route handlers are thin
 * wrappers that translate query/body params to JsonObject tool args
 * and forward.
 *
 * Endpoints:
 *   - GET  /api/notes/list?subdir=...        — directory entries
 *   - GET  /api/notes/read?path=...          — full file contents
 *   - GET  /api/notes/search?query=...&limit — substring search
 *   - POST /api/notes/save  body {path, content, overwrite?}
 *   - POST /api/notes/append body {path, content}
 *
 * Tool error responses (`{ error: "..." }`) propagate as 400 status;
 * everything else is 200. A future iter can refine error-code→status
 * mapping once the consumers settle.
 */

import { createNotesMcpServer, type NotesProviderRegistry } from "@muse/domain-tools";
import { isAppleNotesMirrorEnabled, mirrorNoteToApple } from "@muse/macos";
import type { JsonObject, JsonValue } from "@muse/shared";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import { isJsonObject, isJsonValue } from "./server-input-utils.js";
import { readBodyString, readQueryInteger, readQueryString, toBody } from "./compat-parsers.js";
import type { ServerOptions } from "./server.js";

interface NotesRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly notesDir: string;
  /**
   * Optional registry of all configured notes backends (LocalDir +
   * AppleNotes + Notion etc). When provided, `/api/notes/providers`
   * exposes the list so the CLI / web UI can surface what's wired
   * without going through chat. Distinct from `notesDir`, which is
   * the single filesystem root used by the inline filesystem
   * routes (`/api/notes/list`, `/read`, etc).
   */
  readonly notesProviderRegistry?: NotesProviderRegistry;
}

type ToolResult = string | JsonValue;
type ExecuteFn = (args: JsonObject) => Promise<ToolResult> | ToolResult;

export function registerNotesRoutes(server: FastifyInstance, gate: NotesRoutesGate): void {
  // Opt-in Apple Notes mirror (MUSE_APPLE_NOTES_MIRROR). Injected ONLY when the
  // switch is on so an off/absent posture never reaches osascript (the mirror
  // self-gates on env too). Fires only on `POST /api/notes/save` creates — the
  // save tool's create-only gate — and its `mirrorNote` flows through the
  // handler's result verbatim. There is no ingest REST route, so no over-fire.
  const mcp = createNotesMcpServer({
    notesDir: gate.notesDir,
    ...(isAppleNotesMirrorEnabled(process.env) ? { mirror: (note) => mirrorNoteToApple(note) } : {})
  });
  const tools = new Map<string, ExecuteFn>(
    mcp.tools.map((tool) => [tool.name, tool.execute])
  );

  function normalizeToolResult(raw: unknown): JsonObject {
    if (isJsonObject(raw)) {
      return raw;
    }
    if (isJsonValue(raw)) {
      return { result: raw };
    }
    return { result: null };
  }

  async function callTool(name: string, args: JsonObject): Promise<JsonObject> {
    const execute = tools.get(name);
    if (!execute) {
      throw new Error(`notes tool not found: ${name}`);
    }
    const raw = await execute(args);
    return normalizeToolResult(raw);
  }

  function sendToolResult(
    reply: { status(code: number): { send(payload: unknown): unknown } },
    result: JsonObject
  ): unknown {
    if (typeof result.error === "string") {
      return reply.status(400).send(result);
    }
    return reply.status(200).send(result);
  }

  server.get("/api/notes/list", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const subdir = readQueryString(request, "subdir");
    const result = await callTool("list", subdir ? { subdir } : {});
    return sendToolResult(reply, result);
  });

  server.get("/api/notes/read", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const path = readQueryString(request, "path");
    if (!path) {
      return reply.status(400).send({ error: "path is required" });
    }
    const result = await callTool("read", { path });
    return sendToolResult(reply, result);
  });

  server.get("/api/notes/search", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const query = readQueryString(request, "query");
    if (!query) {
      return reply.status(400).send({ error: "query is required" });
    }
    const limitRaw = readQueryInteger(request, "limit", Number.NaN);
    const limitNum = Number.isFinite(limitRaw) ? limitRaw : undefined;
    const args: JsonObject = {
      query,
      ...(limitNum !== undefined && Number.isFinite(limitNum) ? { limit: limitNum } : {})
    };
    const result = await callTool("search", args);
    return sendToolResult(reply, result);
  });

  server.post("/api/notes/save", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = toBody(request.body);
    const path = readBodyString(body, "path");
    const content = typeof body.content === "string" ? body.content : undefined;
    if (!path || content === undefined) {
      return reply.status(400).send({ error: "path and content are required" });
    }
    const args: JsonObject = {
      content,
      path,
      ...(body.overwrite === true ? { overwrite: true } : {})
    };
    const result = await callTool("save", args);
    return sendToolResult(reply, result);
  });

  server.post("/api/notes/append", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = toBody(request.body);
    const path = typeof body.path === "string" ? body.path : undefined;
    const content = typeof body.content === "string" ? body.content : undefined;
    if (!path || content === undefined) {
      return reply.status(400).send({ error: "path and content are required" });
    }
    const result = await callTool("append", { content, path });
    return sendToolResult(reply, result);
  });

  server.delete("/api/notes", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const path = readQueryString(request, "path");
    if (!path) {
      return reply.status(400).send({ error: "path is required" });
    }
    const result = await callTool("delete", { path });
    return sendToolResult(reply, result);
  });

  server.get("/api/notes/providers", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    // When the assembly didn't wire a registry (e.g. server constructed
    // directly in tests with just `notesDir`), report the inline
    // filesystem-only baseline so the CLI / web UI gets a stable
    // shape regardless of how the server was constructed.
    if (!gate.notesProviderRegistry) {
      return {
        providers: [
          {
            description: `Inline filesystem-only notes store rooted at ${gate.notesDir}.`,
            displayName: "Local directory (inline)",
            id: "local",
            local: true
          }
        ]
      };
    }
    return {
      providers: gate.notesProviderRegistry.describe().map((info) => ({
        description: info.description,
        displayName: info.displayName,
        id: info.id,
        local: info.local
      }))
    };
  });
}
