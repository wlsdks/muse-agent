/**
 * `muse onboard` — the guided path from install to the first cited answer.
 * Muse's wedge only lands if a non-technical, privacy-bound user can FEEL it in
 * five minutes; this command checks readiness and prints the SINGLE next
 * command to run, step by step, until `muse ask` returns a source-cited answer
 * from their own machine. Deterministic: the step logic is pure + tested; the
 * command only gathers state (Ollama reachability, installed models, notes
 * corpus, index) and renders.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveNotesDir } from "@muse/autoconfigure";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface OnboardingState {
  readonly ollamaReachable: boolean;
  /** Model names from Ollama's /api/tags (e.g. "qwen3:8b", "nomic-embed-text:latest"). */
  readonly installedModels: readonly string[];
  /** Resolved local chat model base (e.g. "qwen3:8b"). */
  readonly chatModel: string;
  readonly embedModel: string;
  readonly notesDir: string;
  readonly noteFileCount: number;
  readonly indexBuilt: boolean;
}

export interface OnboardStep {
  readonly id: string;
  readonly title: string;
  readonly status: "ok" | "action";
  readonly detail: string;
  readonly command?: string;
}

export interface OnboardReport {
  readonly steps: readonly OnboardStep[];
  readonly ready: boolean;
  /** The single next command the user should run (the first unmet step), or the ask example when ready. */
  readonly nextCommand: string;
  readonly nextTitle: string;
}

function modelInstalled(installed: readonly string[], name: string): boolean {
  const base = name.split(":")[0];
  return installed.some((m) => m === name || m.split(":")[0] === base);
}

const ASK_EXAMPLE = "muse ask --notes-only \"<a question about something in your notes>\"";

/**
 * Pure: given readiness state, produce the ordered steps + the SINGLE next
 * command. Steps are checked in dependency order (Ollama → chat model → embed
 * model → corpus → index → ask); `nextCommand` is the first step needing
 * action, or the ask example once every prerequisite is met.
 */
export function computeOnboarding(state: OnboardingState): OnboardReport {
  const steps: OnboardStep[] = [];
  const ok = (id: string, title: string, detail: string): OnboardStep => ({ detail, id, status: "ok", title });
  const action = (id: string, title: string, detail: string, command: string): OnboardStep => ({ command, detail, id, status: "action", title });

  steps.push(state.ollamaReachable
    ? ok("ollama", "Local model server (Ollama)", "Ollama is reachable.")
    : action("ollama", "Local model server (Ollama)", "Muse runs on a local model — start Ollama first.", "ollama serve"));

  steps.push(modelInstalled(state.installedModels, state.chatModel)
    ? ok("chat-model", `Chat model (${state.chatModel})`, "Installed.")
    : action("chat-model", `Chat model (${state.chatModel})`, "The local model Muse answers with.", `ollama pull ${state.chatModel}`));

  steps.push(modelInstalled(state.installedModels, state.embedModel)
    ? ok("embed-model", `Embedding model (${state.embedModel})`, "Installed.")
    : action("embed-model", `Embedding model (${state.embedModel})`, "Embeds your notes so Muse can find + cite them.", `ollama pull ${state.embedModel}`));

  steps.push(state.noteFileCount > 0
    ? ok("corpus", "Your corpus", `${state.noteFileCount.toString()} file(s) under ${state.notesDir}.`)
    : action("corpus", "Your corpus", `Add the notes/files you'd never paste into ChatGPT (drop them in ${state.notesDir}), or ingest an export.`, "muse ingest <chatgpt-or-claude-export.json | mail.mbox>"));

  steps.push(state.indexBuilt
    ? ok("index", "Search index", "Built — your corpus is searchable.")
    : action("index", "Search index", "Embed your corpus so cited recall works.", "muse notes reindex"));

  const firstAction = steps.find((s) => s.status === "action");
  const ready = firstAction === undefined;
  return {
    nextCommand: firstAction?.command ?? ASK_EXAMPLE,
    nextTitle: ready ? "Ask your own machine" : firstAction.title,
    ready,
    steps
  };
}

function countCorpusFiles(dir: string, cap = 1_000): number {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0 && count < cap) {
    let entries;
    try {
      entries = readdirSync(stack.pop()!, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join((e as unknown as { parentPath?: string; path?: string }).parentPath ?? (e as unknown as { path: string }).path ?? dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && /\.(md|markdown|txt|pdf)$/iu.test(e.name)) count += 1;
      if (count >= cap) break;
    }
  }
  return count;
}

async function gatherState(io: ProgramIO): Promise<OnboardingState> {
  const env = process.env;
  const baseUrl = (env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/u, "");
  let ollamaReachable = false;
  let installedModels: string[] = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const fetchImpl = io.fetch ?? globalThis.fetch;
    const response = await fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      ollamaReachable = true;
      const body = await response.json() as { models?: { name?: string }[] };
      installedModels = (body.models ?? []).map((m) => m.name ?? "").filter((n) => n.length > 0);
    }
  } catch {
    ollamaReachable = false;
  }
  const chatModel = (env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL ?? "ollama/qwen3:8b").replace(/^ollama\//u, "");
  const embedModel = env.MUSE_EPISODIC_RECALL_EMBED_MODEL?.trim() || "nomic-embed-text";
  const notesDir = resolveNotesDir(env as Record<string, string | undefined>);
  const noteFileCount = countCorpusFiles(notesDir);
  const indexFile = env.MUSE_NOTES_INDEX_FILE?.trim() || join(homedir(), ".muse", "notes-index.json");
  return { chatModel, embedModel, indexBuilt: existsSync(indexFile), installedModels, notesDir, noteFileCount, ollamaReachable };
}

export function registerOnboardCommand(program: Command, io: ProgramIO): void {
  program
    .command("onboard")
    .description("Guided setup: the single next step to your first private, cited answer")
    .option("--json", "Print the raw readiness report")
    .action(async (options: { readonly json?: boolean }) => {
      const report = computeOnboarding(await gatherState(io));
      if (options.json) {
        io.stdout(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      io.stdout("Muse — local, private, cited. Let's get you to your first answer.\n\n");
      for (const step of report.steps) {
        io.stdout(`${step.status === "ok" ? "✓" : "→"} ${step.title}\n   ${step.detail}\n`);
        if (step.command) io.stdout(`   $ ${step.command}\n`);
      }
      io.stdout(report.ready
        ? `\n✅ Ready. Ask your own machine:\n   $ ${report.nextCommand}\n`
        : `\n👉 Next: ${report.nextTitle}\n   $ ${report.nextCommand}\n`);
    });
}
