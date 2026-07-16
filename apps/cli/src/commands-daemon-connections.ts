import { parseBoolean } from "@muse/autoconfigure";
import { CHROME_DEVTOOLS_MCP_SERVER_NAME } from "@muse/mcp";
import type { ChromeSnapshotConnection, runDueFollowups } from "@muse/proactivity";
import type { MuseTool } from "@muse/tools";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";

export type FollowupModel = {
  readonly modelProvider: Parameters<typeof runDueFollowups>[0]["modelProvider"];
  readonly model: string;
};

// Followups REQUIRE a model to synthesize their message. The real
// daemon builds it from the runtime assembly (best-effort — if the
// model can't be resolved, the followup tick is skipped, not fatal).
export async function defaultFollowupModel(_env: NodeJS.ProcessEnv): Promise<FollowupModel | undefined> {
  try {
    const { createMuseRuntimeAssembly } = await import("@muse/autoconfigure");
    const assembly = createMuseRuntimeAssembly();
    if (assembly.modelProvider && assembly.defaultModel) {
      return {
        model: assembly.defaultModel,
        modelProvider: assembly.modelProvider as FollowupModel["modelProvider"]
      };
    }
  } catch { /* fail-soft — followup tick skipped when no model */ }
  return undefined;
}

// Adapt the MCP stack's projected Chrome DevTools tools into the
// `ChromeSnapshotConnection` (just `callTool`) that web-watch needs.
// `take_snapshot` / `navigate_page` map to the `chrome-devtools.*`
// MuseTools' execute.
export function chromeSnapshotConnectionFromTools(tools: readonly MuseTool[]): ChromeSnapshotConnection {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return {
    callTool: async (toolName, args) => {
      const tool = byName.get(`${CHROME_DEVTOOLS_MCP_SERVER_NAME}.${toolName}`);
      if (!tool) {
        throw new Error(`chrome-devtools tool '${toolName}' is not available`);
      }
      // The projected MCP tool ignores the context; web-watch is read-only.
      return tool.execute(args as Parameters<MuseTool["execute"]>[0], { runId: "muse-daemon-web-watch" });
    }
  };
}

// Best-effort real Chrome connection at daemon startup: only when
// MUSE_CHROME_DEVTOOLS_ENABLED (assembleMcpStack auto-registers the
// chrome-devtools server then), connect it and adapt its tools. Any
// failure (Chrome not on the debug port, connect refused) yields
// `undefined` so chrome-source watches skip fail-soft and the daemon
// stays up. The real browser handshake is verified manually, not in CI.
export async function defaultChromeConnection(env: NodeJS.ProcessEnv): Promise<ChromeSnapshotConnection | undefined> {
  if (!parseBoolean(env.MUSE_CHROME_DEVTOOLS_ENABLED, false)) return undefined;
  try {
    const { createMuseRuntimeAssembly } = await import("@muse/autoconfigure");
    const { manager } = createMuseRuntimeAssembly().mcp;
    await manager.initializeFromStore();
    const connected = await manager.connect(CHROME_DEVTOOLS_MCP_SERVER_NAME);
    if (!connected) return undefined;
    return chromeSnapshotConnectionFromTools(manager.toMuseTools());
  } catch {
    return undefined;
  }
}

// Best-effort real ambient enricher: when
// MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED, build createKnowledgeEnricher
// over the user's notes dir + a local Ollama embedder (hybrid+MMR
// retrieval), so an ambient notice's "Related" line is a real note.
// Any failure (no Ollama, no notes) → undefined → plain notices.
export async function defaultKnowledgeEnrich(env: NodeJS.ProcessEnv): Promise<((query: string) => Promise<string | undefined>) | undefined> {
  if (!parseBoolean(env.MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED, false)) return undefined;
  try {
    const { createKnowledgeEnricher, createOllamaEmbedder, resolveNotesDir } = await import("@muse/autoconfigure");
    const { LocalDirNotesProvider } = await import("@muse/domain-tools");
    const notesDir = resolveNotesDir(env as Parameters<typeof resolveNotesDir>[0]);
    return createKnowledgeEnricher({
      embed: createOllamaEmbedder(env.MUSE_KNOWLEDGE_SEARCH_EMBED_MODEL?.trim() ?? DEFAULT_EMBED_MODEL, env),
      notesProvider: new LocalDirNotesProvider({ notesDir })
    });
  } catch {
    return undefined;
  }
}
