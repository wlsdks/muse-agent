/**
 * `muse setup model` — interactive wizard for the LLM provider key
 * + default model id. Persists to `~/.muse/models.json` (chmod 600)
 * and prints the env-var lines the user needs to add to their shell
 * rc so the runtime picks them up.
 *
 * Doesn't touch autoconfigure's boot path. The runtime continues to
 * read environment variables directly; this wizard's job is to
 * collect the keys + tell the user how to wire them. A follow-up
 * iter can teach autoconfigure to fall back to this file (mirroring
 * what messaging already does), so a single `source ~/.muse/env.sh`
 * isn't strictly required forever.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join as pathJoin } from "node:path";

import { isCancel, multiselect, password, text } from "@clack/prompts";

interface SetupModelIO {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
  readonly home?: string;
}

interface ProviderSpec {
  readonly id: "openai" | "anthropic" | "gemini" | "openrouter" | "ollama";
  readonly label: string;
  readonly envKey: string;
  readonly docs: string;
  readonly suggestedModel: string;
  readonly secret: boolean;
  readonly placeholderHint: string;
}

const PROVIDER_SPECS: readonly ProviderSpec[] = [
  {
    docs: "https://ai.google.dev/gemini-api/docs/api-key",
    envKey: "GEMINI_API_KEY",
    id: "gemini",
    label: "Google Gemini",
    placeholderHint: "AIzaSy...",
    secret: true,
    suggestedModel: "gemini/gemini-2.0-flash"
  },
  {
    docs: "https://platform.openai.com/api-keys",
    envKey: "OPENAI_API_KEY",
    id: "openai",
    label: "OpenAI (ChatGPT, GPT-4o)",
    placeholderHint: "sk-proj-...",
    secret: true,
    suggestedModel: "openai/gpt-4o-mini"
  },
  {
    docs: "https://console.anthropic.com/settings/keys",
    envKey: "ANTHROPIC_API_KEY",
    id: "anthropic",
    label: "Anthropic (Claude)",
    placeholderHint: "sk-ant-...",
    secret: true,
    suggestedModel: "anthropic/claude-haiku-4-5-20251001"
  },
  {
    docs: "https://openrouter.ai/keys",
    envKey: "OPENROUTER_API_KEY",
    id: "openrouter",
    label: "OpenRouter (one key, many models)",
    placeholderHint: "sk-or-v1-...",
    secret: true,
    suggestedModel: "openrouter/anthropic/claude-3.5-sonnet"
  },
  {
    docs: "https://ollama.com/download",
    envKey: "OLLAMA_BASE_URL",
    id: "ollama",
    label: "Ollama (local; not a secret)",
    placeholderHint: "http://localhost:11434",
    secret: false,
    suggestedModel: "ollama/llama3.2"
  }
];

interface PersistedShape {
  readonly version: 1;
  readonly providers: Record<string, { readonly token: string; readonly suggestedModel: string }>;
}

export async function runModelSetup(io: SetupModelIO): Promise<void> {
  const home = io.home ?? homedir();
  const file = pathJoin(home, ".muse", "models.json");

  io.stdout(`Model setup — keys will be saved to ${file} (chmod 600).\n`);
  io.stdout("This file isn't auto-loaded yet — the wizard prints export lines for your shell rc.\n\n");

  const selection = await multiselect({
    message: "Which model providers do you want to enable?",
    options: PROVIDER_SPECS.map((spec) => ({ label: spec.label, value: spec.id })),
    required: true
  });

  if (isCancel(selection)) {
    io.stdout("Setup cancelled.\n");
    return;
  }

  const requested = selection as readonly ProviderSpec["id"][];
  const persisted: PersistedShape = await readPersisted(file);
  const collected: Array<{ spec: ProviderSpec; token: string }> = [];

  for (const id of requested) {
    const spec = PROVIDER_SPECS.find((entry) => entry.id === id);
    if (!spec) {
      continue;
    }
    io.stdout(`\n${spec.label}\n  Docs: ${spec.docs}\n`);
    const promptResult = spec.secret
      ? await password({
        mask: "*",
        message: `${spec.envKey} (${spec.placeholderHint}):`,
        validate: (value) => (!value || value.trim().length === 0 ? "Token must not be empty" : undefined)
      })
      : await text({
        message: `${spec.envKey} (${spec.placeholderHint}):`,
        placeholder: spec.placeholderHint,
        validate: (value) => (!value || value.trim().length === 0 ? "Value must not be empty" : undefined)
      });

    if (isCancel(promptResult)) {
      io.stdout(`- ${spec.id} — skipped\n`);
      continue;
    }
    const token = String(promptResult).trim();
    persisted.providers[spec.id] = { suggestedModel: spec.suggestedModel, token };
    collected.push({ spec, token });
  }

  if (collected.length === 0) {
    io.stdout("\nNo providers configured. Nothing saved.\n");
    return;
  }

  await writePersisted(file, persisted);
  io.stdout(`\n✓ Saved ${collected.length.toString()} provider(s) to ${file}\n\n`);
  io.stdout("Add to your shell rc (or run `source <(...)`):\n");
  for (const { spec, token } of collected) {
    io.stdout(`  export ${spec.envKey}=${quoteForShell(token)}\n`);
  }
  // Default model env: use the first selected provider's suggested model.
  io.stdout(`  export MUSE_MODEL=${collected[0]!.spec.suggestedModel}\n`);
  io.stdout("\nTip: `muse setup` shows the current state once env is loaded.\n");
}

async function readPersisted(file: string): Promise<PersistedShape> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
      return { providers: { ...parsed.providers as PersistedShape["providers"] }, version: 1 };
    }
  } catch {
    // missing or malformed → start fresh
  }
  return { providers: {}, version: 1 };
}

async function writePersisted(file: string, value: PersistedShape): Promise<void> {
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

function quoteForShell(value: string): string {
  // Single-quote and escape any embedded single quotes — safe for bash/zsh.
  return `'${value.replace(/'/gu, "'\\''")}'`;
}
