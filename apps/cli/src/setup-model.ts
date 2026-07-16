/**
 * `muse setup model` — interactive wizard for the LLM provider key
 * + default model id. Persists to `~/.muse/models.json` (chmod 600).
 *
 * `mergeModelKeysFromFile` in autoconfigure auto-loads this file at
 * runtime boot, so the user doesn't need shell-rc exports — running
 * the wizard once is enough. The wizard prints the resolved
 * environment names + the chosen MUSE_MODEL so the user knows what
 * the next `muse` invocation will see.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import { isCancel, multiselect, password, text } from "@clack/prompts";
import {
  backupPlaintextCredentialsFile,
  credentialEncryptionEnabled,
  decodeMaybeEncryptedCredentialsJson,
  encryptCredentialEnvelope,
  isCredentialsFileEncryptedAtRest
} from "@muse/shared";
import { atomicWriteFile, withFileLock, withFileMutationQueue } from "@muse/stores";

interface SetupModelIO {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
  readonly home?: string;
  /** Defaults to `process.env`; tests inject `MUSE_MEMORY_KEY` / `MUSE_CREDENTIALS_ENCRYPT`. */
  readonly env?: NodeJS.ProcessEnv;
}

type SetupModelProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "ollama"
  | "groq"
  | "deepseek"
  | "together"
  | "mistral"
  | "moonshot"
  | "cerebras";

export interface SetupModelProviderSpec {
  readonly id: SetupModelProviderId;
  readonly label: string;
  readonly envKey: string;
  readonly docs: string;
  readonly suggestedModel: string;
  readonly secret: boolean;
  readonly placeholderHint: string;
}

export const SETUP_MODEL_PROVIDER_SPECS: readonly SetupModelProviderSpec[] = [
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
    suggestedModel: "openrouter/google/gemini-2.0-flash-001"
  },
  {
    docs: "https://ollama.com/download",
    envKey: "OLLAMA_BASE_URL",
    id: "ollama",
    label: "Ollama (local; not a secret)",
    // 127.0.0.1, not localhost: the runtime resolver defaults to
    // 127.0.0.1 and Ollama binds IPv4, so a localhost hint steers
    // IPv6 hosts into a phantom "unreachable".
    placeholderHint: "http://127.0.0.1:11434",
    secret: false,
    suggestedModel: "ollama/llama3.2"
  },
  {
    docs: "https://console.groq.com/keys",
    envKey: "GROQ_API_KEY",
    id: "groq",
    label: "Groq (fast Llama / Mixtral hosting)",
    placeholderHint: "gsk_...",
    secret: true,
    suggestedModel: "groq/llama-3.3-70b-versatile"
  },
  {
    docs: "https://platform.deepseek.com/api_keys",
    envKey: "DEEPSEEK_API_KEY",
    id: "deepseek",
    label: "DeepSeek (DeepSeek-Chat / Coder)",
    placeholderHint: "sk-...",
    secret: true,
    suggestedModel: "deepseek/deepseek-chat"
  },
  {
    docs: "https://api.together.xyz/settings/api-keys",
    envKey: "TOGETHER_API_KEY",
    id: "together",
    label: "Together AI (open-weight model marketplace)",
    placeholderHint: "tgp_...",
    secret: true,
    suggestedModel: "together/meta-llama/Llama-3.3-70B-Instruct-Turbo"
  },
  {
    docs: "https://console.mistral.ai/api-keys",
    envKey: "MISTRAL_API_KEY",
    id: "mistral",
    label: "Mistral (mistral-large / codestral)",
    placeholderHint: "32-char opaque token",
    secret: true,
    suggestedModel: "mistral/mistral-small-latest"
  },
  {
    docs: "https://platform.moonshot.ai/console/api-keys",
    envKey: "MOONSHOT_API_KEY",
    id: "moonshot",
    label: "Moonshot (Kimi)",
    placeholderHint: "sk-...",
    secret: true,
    suggestedModel: "moonshot/moonshot-v1-8k"
  },
  {
    docs: "https://cloud.cerebras.ai/platform/keys",
    envKey: "CEREBRAS_API_KEY",
    id: "cerebras",
    label: "Cerebras (fastest Llama inference)",
    placeholderHint: "csk-...",
    secret: true,
    suggestedModel: "cerebras/llama-3.3-70b"
  }
];

const PROVIDER_SPECS = SETUP_MODEL_PROVIDER_SPECS;

interface PersistedShape {
  readonly version: 1;
  readonly providers: Record<string, { readonly token: string; readonly suggestedModel: string }>;
}

export async function runModelSetup(io: SetupModelIO): Promise<void> {
  const home = io.home ?? homedir();
  const file = pathJoin(home, ".muse", "models.json");

  io.stdout(`Model setup — keys will be saved to ${file} (chmod 600).\n`);
  io.stdout("autoconfigure loads this file at boot, so no shell-rc exports are required.\n\n");

  const selection = await multiselect({
    message: "Which model providers do you want to enable?",
    options: PROVIDER_SPECS.map((spec) => ({ label: spec.label, value: spec.id })),
    required: true
  });

  if (isCancel(selection)) {
    io.stdout("Setup cancelled.\n");
    return;
  }

  const env = io.env ?? process.env;
  const requested = selection as readonly SetupModelProviderSpec["id"][];
  const collected: Array<{ spec: SetupModelProviderSpec; token: string }> = [];

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
    collected.push({ spec, token });
  }

  if (collected.length === 0) {
    io.stdout("\nNo providers configured. Nothing saved.\n");
    return;
  }

  await mergePersistedProviders(
    file,
    Object.fromEntries(collected.map(({ spec, token }) => [spec.id, { suggestedModel: spec.suggestedModel, token }])),
    env
  );
  io.stdout(`\n✓ Saved ${collected.length.toString()} provider(s) to ${file}\n`);
  io.stdout("autoconfigure will load these at next boot. Resolved environment:\n");
  for (const { spec, token } of collected) {
    io.stdout(`  ${spec.envKey} = ${maskSecret(token)}\n`);
  }
  // Default model env: use the first selected provider's suggested
  // model. mergeModelKeysFromFile auto-derives MUSE_MODEL from this
  // when env doesn't already have one.
  io.stdout(`  MUSE_MODEL    = ${collected[0]!.spec.suggestedModel}  (override with MUSE_MODEL=… in env)\n`);
  io.stdout("\nTip: `muse setup` shows the current state.\n");
}

/**
 * Persist a single provider's key to `~/.muse/models.json` (chmod 600) — the
 * same store `muse setup model` writes and autoconfigure auto-loads at boot
 * (`mergeModelKeysFromFile`), so no shell-rc exports are needed. Reused by the
 * first-run wizard's Cloud path to keep key handling turnkey and in ONE place.
 */
export async function persistModelProviderKey(
  home: string,
  providerId: string,
  token: string,
  suggestedModel: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const file = pathJoin(home, ".muse", "models.json");
  await mergePersistedProviders(file, { [providerId]: { suggestedModel, token } }, env);
  return file;
}

function maskSecret(token: string): string {
  if (token.length <= 8) {
    return "*".repeat(token.length);
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * Format-preserving read: transparently decrypts an encrypted envelope OR
 * reads legacy plaintext — an existing user's plaintext `models.json` keeps
 * working unchanged. A wrong `MUSE_MEMORY_KEY` on an ENCRYPTED file THROWS
 * (fail-closed), never silently starts fresh (that would look like "no keys
 * configured" and could prompt the user to overwrite recoverable data).
 */
async function readPersisted(file: string, env: NodeJS.ProcessEnv = process.env): Promise<PersistedShape> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { providers: {}, version: 1 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { providers: {}, version: 1 };
  }
  parsed = decodeMaybeEncryptedCredentialsJson(parsed, env); // THROWS fail-closed on a wrong key
  const shape = parsed as Partial<PersistedShape>;
  if (shape && typeof shape === "object" && shape.providers && typeof shape.providers === "object") {
    return { providers: { ...shape.providers }, version: 1 };
  }
  return { providers: {}, version: 1 };
}

/**
 * Atomic write. Encrypts only when `MUSE_CREDENTIALS_ENCRYPT` is enabled AND
 * a key is available, OR the file is ALREADY encrypted on disk (sticky —
 * once encrypted, stays encrypted even if the env flag is later unset).
 * Absent both, writes plaintext (chmod 600) exactly as before — a keyless
 * setup is never hard-broken. The first plaintext→encrypted transition backs
 * up the existing plaintext so a lost key can't make keys unrecoverable.
 */
async function writePersisted(file: string, value: PersistedShape, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const alreadyEncrypted = await isCredentialsFileEncryptedAtRest(file);
  const shouldEncrypt = credentialEncryptionEnabled(env) || alreadyEncrypted;
  if (shouldEncrypt && !alreadyEncrypted) {
    const existing = await fs.readFile(file, "utf8").catch(() => undefined);
    if (existing !== undefined) {
      await backupPlaintextCredentialsFile(file, existing);
    }
  }
  const content = shouldEncrypt ? `${JSON.stringify(encryptCredentialEnvelope(payload, env))}\n` : payload;
  await atomicWriteFile(file, content);
}

/**
 * Merge new provider settings against the latest on-disk credentials while
 * holding the shared cross-process mutation lock. Setup UIs can stay open for
 * minutes, so their earlier read must never overwrite a provider configured by
 * a concurrent first-run wizard or another CLI process.
 */
async function mergePersistedProviders(
  file: string,
  providers: Readonly<PersistedShape["providers"]>,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await withFileMutationQueue(file, () =>
    withFileLock(file, async () => {
      const current = await readPersisted(file, env);
      await writePersisted(file, { providers: { ...current.providers, ...providers }, version: 1 }, env);
    })
  );
}
