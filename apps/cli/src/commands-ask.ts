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

import { buildCalendarRegistry, createMuseRuntimeAssembly, resolveNotesDir, resolveRemindersFile, resolveTasksFile } from "@muse/autoconfigure";
import type { CalendarEvent } from "@muse/calendar";
import { readReminders, readTasks, type PersistedReminder, type PersistedTask } from "@muse/mcp";
import type { Command } from "commander";

import { isNotesIndexStale, reindexNotes } from "./commands-notes-rag.js";
import { buildJarvisPersona, readPipedStdin } from "./program.js";
import type { ProgramIO } from "./program.js";

interface AskOptions {
  readonly user?: string;
  readonly persona?: string;
  readonly model?: string;
  readonly top?: string;
  readonly embedModel?: string;
  readonly autoReindex?: boolean;
  readonly tasks?: boolean;
  readonly calendar?: boolean;
  readonly calendarDays?: string;
  readonly reminders?: boolean;
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
    .description("Ask a question with your notes as context — RAG-grounded one-shot via local Qwen. Reads piped stdin too: `cat doc.md | muse ask 'summarize this'`")
    .argument("[query...]", "Free-text question (omit to read entire query from stdin)")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .option("--model <tag>", "Chat model override")
    .option("--top <k>", "Top-K notes chunks to inject as context (default 3)", "3")
    .option("--embed-model <tag>", "Embedding model (must match the index)", "nomic-embed-text")
    .option(
      "--no-auto-reindex",
      "Skip the auto-stale check before search (default: reindex incrementally when a note's mtime is newer than the index)"
    )
    .option(
      "--no-tasks",
      "Skip injecting open tasks as grounding context (default: include open tasks alongside notes so 'what should I focus on?' answers correctly)"
    )
    .option(
      "--no-calendar",
      "Skip injecting upcoming calendar events as grounding context (default: include events from the configured providers)"
    )
    .option(
      "--calendar-days <n>",
      "Window (in days from now) to pull calendar events into context (default 7)",
      "7"
    )
    .option(
      "--no-reminders",
      "Skip injecting pending reminders as grounding context (default: include pending reminders sorted by due date)"
    )
    .action(async (queryParts: readonly string[], options: AskOptions) => {
      const argQuery = queryParts.join(" ").trim();
      const piped = await (io.readPipedStdin ?? readPipedStdin)();

      // Composition follows the same idiom as `muse chat`:
      //   args + stdin → instruction first, content after
      //   args only     → use args
      //   stdin only    → treat stdin as the question
      //   neither       → usage error
      // Lets `cat doc.md | muse ask "summarize this"` work, plus
      // `echo "question?" | muse ask` for headless pipelines.
      let query: string;
      if (argQuery.length > 0 && piped.length > 0) {
        query = `${argQuery}\n\n${piped}`;
      } else if (argQuery.length > 0) {
        query = argQuery;
      } else if (piped.length > 0) {
        query = piped;
      } else {
        io.stderr("usage: muse ask <query>   |   cat content | muse ask [optional-instruction]\n");
        process.exitCode = 1;
        return;
      }
      const userKey = defaultUserKey(options.user, options.persona);
      const topK = Math.max(1, Math.min(20, Number.parseInt(options.top ?? "3", 10) || 3));
      const embedModel = options.embedModel ?? "nomic-embed-text";

      // Auto-stale check + incremental reindex (default on). JARVIS
      // shouldn't make the user remember to run reindex; if a note
      // file is newer than the index, just refresh before search.
      const notesDir = resolveNotesDir(process.env as Record<string, string | undefined>);
      if (options.autoReindex !== false) {
        try {
          const stale = await isNotesIndexStale(notesDir, notesIndexPath());
          if (stale) {
            const summary = await reindexNotes({
              dir: notesDir,
              indexPath: notesIndexPath(),
              model: embedModel
            });
            if (summary.embedded > 0) {
              io.stderr(`(auto-refreshed notes index: ${summary.embedded.toString()} embedded, ${summary.skipped.toString()} cached)\n`);
            }
          }
        } catch (cause) {
          io.stderr(`(auto-reindex skipped: ${cause instanceof Error ? cause.message : String(cause)})\n`);
        }
      }

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

      // Pull open tasks as a second grounding source. Real JARVIS
      // questions ("what should I focus on today?", "what's left
      // for the wedding?") hit tasks, not notes — and we have a
      // task store already. Sort by due date so the most imminent
      // are first; cap the dump to keep the prompt tight.
      let openTasks: readonly PersistedTask[] = [];
      if (options.tasks !== false) {
        try {
          const tasksFile = resolveTasksFile(process.env as Record<string, string | undefined>);
          const all = await readTasks(tasksFile);
          openTasks = all
            .filter((t) => t.status === "open")
            .sort((a, b) => {
              const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
              const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
              return ad - bd;
            })
            .slice(0, 20);
        } catch {
          // tasks file missing or unreadable — silently skip, notes
          // grounding still works
        }
      }
      const taskBlock = openTasks.length === 0
        ? "(no open tasks)"
        : openTasks
          .map((t, i) => {
            const due = t.dueAt ? ` (due ${t.dueAt})` : "";
            const urgent = t.urgent ? " [URGENT]" : "";
            return `<<task ${(i + 1).toString()} — ${t.id}${urgent}>>\n${t.title}${due}\n<<end>>`;
          })
          .join("\n\n");

      // Pull upcoming calendar events as a third grounding source.
      // "What's on my schedule this week?", "any meetings tomorrow?",
      // "when am I free?" — questions the LLM can only answer if it
      // sees the events. Iterate over all registered providers
      // (local + gcal + caldav + macos) so users with mixed setups
      // get one merged view.
      let upcomingEvents: readonly CalendarEvent[] = [];
      if (options.calendar !== false) {
        const days = Math.max(1, Math.min(30, Number.parseInt(options.calendarDays ?? "7", 10) || 7));
        const from = new Date();
        const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
        try {
          const registry = buildCalendarRegistry(process.env as Record<string, string | undefined>);
          const providers = registry.list();
          const collected: CalendarEvent[] = [];
          for (const provider of providers) {
            try {
              const events = await provider.listEvents({ from, to });
              collected.push(...events);
            } catch {
              // single provider failed (auth lapsed, network) —
              // keep going with whatever we got
            }
          }
          upcomingEvents = collected
            .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
            .slice(0, 20);
        } catch {
          // registry assembly failed — skip calendar grounding
        }
      }
      const calendarBlock = upcomingEvents.length === 0
        ? "(no upcoming events)"
        : upcomingEvents
          .map((e, i) => {
            const when = e.allDay
              ? `${e.startsAt.toISOString().slice(0, 10)} (all-day)`
              : `${e.startsAt.toISOString()} → ${e.endsAt.toISOString()}`;
            const loc = e.location ? ` @ ${e.location}` : "";
            const provider = `[${e.providerId}]`;
            return `<<event ${(i + 1).toString()} — ${provider}>>\n${e.title}${loc}\n${when}\n<<end>>`;
          })
          .join("\n\n");

      // Pull pending reminders as a fourth grounding source.
      // Reminders are fire-once notifications ("ping me in 2 hours"),
      // distinct from tasks (general TODOs) and events (timed
      // meetings). "What reminders did I set?" / "anything I asked
      // you to remind me of?" lands here.
      let pendingReminders: readonly PersistedReminder[] = [];
      if (options.reminders !== false) {
        try {
          const file = resolveRemindersFile(process.env as Record<string, string | undefined>);
          const all = await readReminders(file);
          pendingReminders = all
            .filter((r) => r.status === "pending")
            .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
            .slice(0, 20);
        } catch {
          // file missing — silently skip
        }
      }
      const reminderBlock = pendingReminders.length === 0
        ? "(no pending reminders)"
        : pendingReminders
          .map((r, i) => `<<reminder ${(i + 1).toString()} — ${r.id} (due ${r.dueAt})>>\n${r.text}\n<<end>>`)
          .join("\n\n");

      const systemPrompt = [
        ...(personaPrompt ? [personaPrompt, ""] : []),
        "You are Muse, the user's JARVIS-style personal AI conductor.",
        "Answer the user's question USING ONLY the notes, open tasks, upcoming events, and pending reminders provided below as context.",
        "If none of the provided context contains enough information, say so directly — do not invent facts.",
        "Reply in the user's preferred language (from persona prefs).",
        "Keep it concise — 2–4 sentences unless the question explicitly needs more.",
        "Do NOT include the raw markers (<<note N>>, <<task N>>, <<event N>>, <<reminder N>>) in your answer; just speak naturally.",
        "Cite sources inline: '[from <file>]' for notes, '[task: <title>]' for tasks, '[event: <title>]' for calendar entries, '[reminder: <text>]' for reminders.",
        "",
        "=== USER NOTES (top relevant chunks) ===",
        contextBlock,
        "=== END NOTES ===",
        "",
        "=== USER OPEN TASKS (sorted by due date, most imminent first) ===",
        taskBlock,
        "=== END TASKS ===",
        "",
        "=== UPCOMING CALENDAR EVENTS (sorted chronologically) ===",
        calendarBlock,
        "=== END CALENDAR ===",
        "",
        "=== PENDING REMINDERS (sorted by due date) ===",
        reminderBlock,
        "=== END REMINDERS ==="
      ].join("\n");

      // Show citation header before streaming the answer so the user
      // sees what's being grounded against, then the model output.
      const groundedParts: string[] = [];
      if (scored.length > 0) {
        groundedParts.push(`${scored.length.toString()} note chunk(s) — ${scored.map((r) => r.file.split("/").pop()).join(", ")}`);
      }
      if (openTasks.length > 0) {
        groundedParts.push(`${openTasks.length.toString()} open task(s)`);
      }
      if (upcomingEvents.length > 0) {
        groundedParts.push(`${upcomingEvents.length.toString()} upcoming event(s)`);
      }
      if (pendingReminders.length > 0) {
        groundedParts.push(`${pendingReminders.length.toString()} pending reminder(s)`);
      }
      // Grounding diagnostic goes to stderr so `muse ask "?" > answer.txt`
      // and `| jq` style pipelines get a clean stdout. Same convention
      // as the auto-reindex banner above. The blank line separating
      // header from answer body stays out of stdout entirely.
      if (groundedParts.length > 0) {
        io.stderr(`(grounded on ${groundedParts.join("; ")})\n`);
      } else {
        io.stderr("(no matching notes, tasks, events, or reminders — answering from persona + general knowledge)\n");
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
