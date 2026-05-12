/**
 * `muse ask <query>` — RAG-grounded one-shot question.
 *
 * The natural JARVIS surface: "what did I say about Q3 last week?"
 * Combines three layers Muse already owns:
 *   1. Persona snapshot from `~/.muse/user-memory.json`
 *      (so the reply is in the user's preferred language + style)
 *   2. Semantic search over `~/.muse/notes-index.json`
 *      (top-K chunks with cosine similarity, embedded with
 *      nomic-embed-text)
 *   3. Local Qwen via `OllamaProvider` (think:false fast path)
 *
 * Streams the answer to stdout. Returns 1 when no index exists
 * (caller is told to run `muse notes reindex` first).
 *
 * Differs from `muse chat <prompt>` by:
 *   - Always runs RAG retrieval first
 *   - Includes hit citations in the system prompt
 *   - Prompts the model to answer FROM the notes (with a "I don't
 *     see anything about that in your notes" fallback)
 *
 * Zero recurring cost — all local.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import type { Command } from "commander";

import { buildJarvisPersona } from "./program.js";
import type { ProgramIO } from "./program.js";

interface AskOptions {
  readonly user?: string;
  readonly persona?: string;
  readonly model?: string;
  readonly top?: string;
  readonly embedModel?: string;
}

interface IndexChunk {
  readonly file: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly embedding: number[];
}

interface FileEntry {
  readonly path: string;
  readonly chunks: readonly IndexChunk[];
}

interface NotesIndex {
  readonly version: 1;
  readonly model: string;
  readonly files: readonly FileEntry[];
}

function notesIndexPath(): string {
  return join(homedir(), ".muse", "notes-index.json");
}

function ollamaUrl(): string {
  return (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
}

function defaultUserKey(user: string | undefined, persona: string | undefined): string {
  const base = user ?? process.env.MUSE_USER_ID ?? process.env.USER ?? "default";
  return persona && persona.length > 0 ? `${base}@${persona}` : base;
}

async function embed(text: string, model: string): Promise<number[]> {
  const resp = await fetch(`${ollamaUrl()}/api/embeddings`, {
    body: JSON.stringify({ model, prompt: text }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!resp.ok) {
    throw new Error(`embeddings ${resp.status.toString()}: ${await resp.text().catch(() => "")}`);
  }
  const body = await resp.json() as { embedding?: number[] };
  if (!body.embedding) throw new Error("missing embedding");
  return body.embedding;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function registerAskCommand(program: Command, io: ProgramIO): void {
  program
    .command("ask")
    .description("Ask a question with your notes as context — RAG-grounded one-shot via local Qwen")
    .argument("<query...>", "Free-text question")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .option("--model <tag>", "Chat model override")
    .option("--top <k>", "Top-K notes chunks to inject as context (default 3)", "3")
    .option("--embed-model <tag>", "Embedding model (must match the index)", "nomic-embed-text")
    .action(async (queryParts: readonly string[], options: AskOptions) => {
      const query = queryParts.join(" ").trim();
      if (query.length === 0) {
        io.stderr("usage: muse ask <query>\n");
        process.exitCode = 1;
        return;
      }
      const userKey = defaultUserKey(options.user, options.persona);
      const topK = Math.max(1, Math.min(20, Number.parseInt(options.top ?? "3", 10) || 3));
      const embedModel = options.embedModel ?? "nomic-embed-text";

      // Load notes index — soft-fail with hint if missing
      let index: NotesIndex | undefined;
      try {
        const raw = await readFile(notesIndexPath(), "utf8");
        index = JSON.parse(raw) as NotesIndex;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          io.stderr("No notes index at ~/.muse/notes-index.json. Run `muse notes reindex` first.\n");
          process.exitCode = 1;
          return;
        }
        throw cause;
      }
      if (index.model !== embedModel) {
        io.stderr(`Index was built with embed model '${index.model}', not '${embedModel}'. Re-index or pass --embed-model ${index.model}.\n`);
        process.exitCode = 1;
        return;
      }

      // Embed query + rank chunks
      const queryEmbedding = await embed(query, embedModel);
      const scored = index.files.flatMap((f) => f.chunks.map((chunk) => ({
        chunk,
        file: f.path,
        score: cosine(queryEmbedding, chunk.embedding)
      })))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      // Build assembly + chat-only fast path
      const assembly = createMuseRuntimeAssembly();
      if (!assembly.modelProvider || !(options.model ?? assembly.defaultModel)) {
        io.stderr("muse ask requires a configured model. Set MUSE_MODEL or pass --model.\n");
        process.exitCode = 2;
        return;
      }
      const model = options.model ?? assembly.defaultModel!;

      const userMemory = await Promise.resolve(assembly.userMemoryStore.findByUserId(userKey));
      const personaPrompt = userMemory ? buildJarvisPersona(userMemory, userKey) : undefined;

      // Compose RAG context block
      const contextBlock = scored.length === 0
        ? "(no relevant notes found)"
        : scored.map((r, i) => `<<note ${(i + 1).toString()} — ${r.file} (score ${r.score.toFixed(3)})>>\n${r.chunk.text}\n<<end>>`).join("\n\n");

      const systemPrompt = [
        ...(personaPrompt ? [personaPrompt, ""] : []),
        "You are Muse, the user's JARVIS-style personal AI conductor.",
        "Answer the user's question USING ONLY the notes provided below as context.",
        "If the notes don't contain enough information, say so directly — do not invent facts.",
        "Reply in the user's preferred language (from persona prefs).",
        "Keep it concise — 2–4 sentences unless the question explicitly needs more.",
        "Do NOT include the raw note markers (<<note N>>) in your answer; just speak naturally.",
        "Cite the source filename inline like '[from <file>]' when you draw on a specific note.",
        "",
        "=== USER NOTES (top relevant chunks) ===",
        contextBlock,
        "=== END NOTES ==="
      ].join("\n");

      // Show citation header before streaming the answer so the user
      // sees what's being grounded against, then the model output.
      if (scored.length > 0) {
        io.stdout(`(grounded on ${scored.length.toString()} chunk(s) — ${scored.map((r) => r.file.split("/").pop()).join(", ")})\n\n`);
      } else {
        io.stdout("(no matching notes — answering from persona + general knowledge)\n\n");
      }

      for await (const event of assembly.modelProvider.stream({
        messages: [
          { content: systemPrompt, role: "system" },
          { content: query, role: "user" }
        ],
        model
      }) as AsyncIterable<{ type: string; text?: string }>) {
        if (event.type === "text-delta" && typeof event.text === "string") {
          io.stdout(event.text);
        }
      }
      io.stdout("\n");
    });
}
