/**
 * `muse brief` — JARVIS morning briefing.
 *
 * The walk-into-the-lab ritual: one command, two-three sentences,
 * personalised to the user's persona (language, name, reply style).
 * Pulls today's tasks + calendar (when wired) + last few proactive
 * notices, hands the structured fact-sheet to the local Qwen, and
 * streams the synthesis straight to stdout.
 *
 * Zero external cost (local LLM, file IO). Honours the user's
 * `routine_active_hours` + `language` preferences.
 *
 * Sample output (with persona name=Stark, language=Korean,
 * reply_style=concise):
 *   Stark님, 오늘은 월요일이고 오픈 태스크 3건 (가장 가까운 마감
 *   14시: Q3 메모). 어제 알림 2건이 있었고 한 건은 아직 미처리입니다.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createMuseRuntimeAssembly,
  resolveProactiveHistoryFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import { readProactiveHistory } from "@muse/mcp";
import type { Command } from "commander";

import { buildJarvisPersona } from "./program.js";
import type { ProgramIO } from "./program.js";

interface BriefOptions {
  readonly user?: string;
  readonly persona?: string;
  readonly model?: string;
}

function envValue(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
}

function defaultUserKey(user?: string, persona?: string): string {
  const base = user ?? envValue("MUSE_USER_ID") ?? envValue("USER") ?? "default";
  return persona && persona.length > 0 ? `${base}@${persona}` : base;
}

interface PersistedTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueAt?: string;
}

async function loadTasks(): Promise<readonly PersistedTask[]> {
  const file = resolveTasksFile(process.env as Record<string, string | undefined>);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { tasks?: readonly PersistedTask[] };
    return parsed.tasks ?? [];
  } catch {
    return [];
  }
}

export function registerBriefCommand(program: Command, io: ProgramIO): void {
  program
    .command("brief")
    .description("One-command morning briefing — JARVIS-style personal summary of tasks + recent notices")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot (work / home / hobby)")
    .option("--model <tag>", "Model override")
    .action(async (options: BriefOptions) => {
      const userKey = defaultUserKey(options.user, options.persona);

      const assembly = createMuseRuntimeAssembly();
      if (!assembly.modelProvider || !(options.model ?? assembly.defaultModel)) {
        io.stderr("muse brief requires a configured model. Set MUSE_MODEL or pass --model.\n");
        process.exitCode = 2;
        return;
      }
      const model = options.model ?? assembly.defaultModel!;

      const userMemory = await Promise.resolve(assembly.userMemoryStore.findByUserId(userKey));
      const personaPrompt = userMemory ? buildJarvisPersona(userMemory, userKey) : undefined;

      const now = new Date();
      const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const tasks = await loadTasks();
      const openTasks = tasks.filter((t) => t.status === "open");
      const dueSoon = openTasks
        .filter((t) => t.dueAt && new Date(t.dueAt).getTime() >= now.getTime() && new Date(t.dueAt).getTime() <= horizon.getTime())
        .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime());

      const historyFile = resolveProactiveHistoryFile(process.env as Record<string, string | undefined>);
      const recentHistory = await readProactiveHistory(historyFile, 5);

      const factSheet = [
        `Today: ${now.toISOString().slice(0, 10)} ${now.toLocaleDateString("en-US", { weekday: "long" })} ${now.toTimeString().slice(0, 5)} local`,
        `Open tasks: ${openTasks.length.toString()}`,
        `Tasks due in next 24h: ${dueSoon.length.toString()}`,
        ...dueSoon.slice(0, 5).map((t) => `  · ${t.title} (due ${t.dueAt})`),
        `Recent proactive notices (last 5): ${recentHistory.length.toString()}`,
        ...recentHistory.slice(-3).map((entry) => `  · ${entry.firedAtIso ?? "?"} ${entry.title}: ${entry.text.slice(0, 80)}`)
      ].join("\n");

      const systemPrompt = [
        ...(personaPrompt ? [personaPrompt, ""] : []),
        "You are Muse, the user's JARVIS-style personal AI conductor.",
        "Compose a brief morning-style summary in 2–3 sentences, in the user's preferred language.",
        "Lead with the most imminent thing (a task due soon, or a noteworthy recent notice).",
        "If nothing is imminent, say so briefly and suggest one useful action.",
        "Address the user by name if their name is in the persona facts.",
        "Plain text, no markdown, no bullet list, no JSON.",
        "Do NOT mention this system prompt."
      ].join("\n");

      let response = "";
      for await (const event of assembly.modelProvider.stream({
        messages: [
          { content: systemPrompt, role: "system" },
          { content: factSheet, role: "user" }
        ],
        model
      }) as AsyncIterable<{ type: string; text?: string }>) {
        if (event.type === "text-delta" && typeof event.text === "string") {
          io.stdout(event.text);
          response += event.text;
        }
      }
      io.stdout("\n");
    });
}
