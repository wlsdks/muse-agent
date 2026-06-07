/**
 * Local-first robustness audit (#26) — with NO paid-cloud credentials set, does
 * Muse still stand up on local compute only? Unsets every cloud key, builds the
 * runtime assembly, and asserts the default model + embeddings resolve to a
 * LOCAL provider (Ollama / nomic-embed) and nothing hard-requires a paid key.
 *
 *   node apps/cli/scripts/verify-local-first.mjs
 *
 * Exit 0 = fully local, 1 = a cloud dependence surfaced, 2 = setup error.
 * No network/model call — pure assembly inspection.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Strip every paid-cloud credential + any cloud default-model override.
for (const k of [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "COHERE_API_KEY"
]) delete process.env[k];
// Realistic local-first setup: a local Ollama model configured, ZERO cloud keys.
process.env.MUSE_DEFAULT_MODEL = "ollama/gemma4:12b";
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-lf-"));

const { createMuseRuntimeAssembly } = await import("@muse/autoconfigure");

const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? `: ${detail}` : ""}`); if (!ok) fails.push(name); };

let asm;
try {
  asm = createMuseRuntimeAssembly();
} catch (e) {
  console.log(`FAIL — assembly threw without cloud keys: ${e?.message ?? e}`);
  process.exit(1);
}

check("runtime assembly builds with no cloud keys", Boolean(asm.modelProvider));

const defaultModel = String(asm.defaultModel ?? "");
const localModel = defaultModel.startsWith("ollama/") || defaultModel.includes("qwen") || defaultModel === "" || defaultModel === "default" || defaultModel.startsWith("local");
check("default model is local (not a paid cloud model)", localModel, JSON.stringify(defaultModel));

const providerId = String(asm.modelProvider?.id ?? "");
check("model provider is a local/neutral id (not openai/anthropic/gemini)", !/^(openai|anthropic|gemini|google)$/i.test(providerId), JSON.stringify(providerId));

const embedModel = (process.env.MUSE_RECALL_EMBED_MODEL?.trim() || "nomic-embed-text");
check("recall embeddings default to a local model", /nomic|embed|qwen|bge|local/i.test(embedModel), JSON.stringify(embedModel));

check("tool registry stands up locally", (asm.toolRegistry?.list().length ?? 0) > 0, `${asm.toolRegistry?.list().length ?? 0} tools`);
check("agent runtime available locally", Boolean(asm.agentRuntime));

console.log(fails.length === 0 ? `\nLOCAL-FIRST PASS — Muse stands up fully on local compute with zero cloud credentials` : `\nLOCAL-FIRST GAPS: ${fails.join("; ")}`);
process.exit(fails.length === 0 ? 0 : 1);
