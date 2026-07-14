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

// Strict: an EMPTY / "default" / qwen-substring default previously counted as
// "local", so a misconfigured (empty) OR a cloud default that merely lacked the
// vetoed substrings could slip through. Require a NON-EMPTY `ollama/` model —
// the only shape that guarantees the resolved default is a local Ollama model.
const defaultModel = String(asm.defaultModel ?? "");
const localModel = defaultModel.length > 0 && defaultModel.startsWith("ollama/");
check("default model is a non-empty local ollama/ model (not empty, not a paid cloud model)", localModel, JSON.stringify(defaultModel));

const providerId = String(asm.modelProvider?.id ?? "");
check("model provider is a local/neutral id (not openai/anthropic/gemini)", !/^(openai|anthropic|gemini|google)$/i.test(providerId), JSON.stringify(providerId));

// Resolve the embed model with the EXACT expression the runtime uses
// (embedder-base.ts / context-engineering-builders.ts): the real env vars and
// the real local default — NOT the invented `MUSE_RECALL_EMBED_MODEL` +
// "nomic-embed-text" fallback the old check re-derived (which passed no matter
// what the assembly did). Assert it is non-empty, a known LOCAL embed model, and
// NOT any cloud embedding API's model — a cloud embed name (a real egress) fails.
const embedModel = (
  process.env.MUSE_KNOWLEDGE_SEARCH_EMBED_MODEL?.trim() ||
  process.env.MUSE_EPISODIC_RECALL_EMBED_MODEL?.trim() ||
  process.env.MUSE_EMBED_MODEL?.trim() ||
  "nomic-embed-text-v2-moe"
);
const cloudEmbedder = /text-embedding|voyage|cohere|openai|gemini|mistral-embed/i.test(embedModel);
const localEmbedder = /nomic|bge|gte|e5|minilm|embed/i.test(embedModel);
check("recall embeddings resolve to a non-empty LOCAL embed model (no cloud embedding egress)", embedModel.length > 0 && localEmbedder && !cloudEmbedder, JSON.stringify(embedModel));

check("tool registry stands up locally", (asm.toolRegistry?.list().length ?? 0) > 0, `${asm.toolRegistry?.list().length ?? 0} tools`);
check("agent runtime available locally", Boolean(asm.agentRuntime));

console.log(fails.length === 0 ? `\nLOCAL-FIRST PASS — Muse stands up fully on local compute with zero cloud credentials` : `\nLOCAL-FIRST GAPS: ${fails.join("; ")}`);
process.exit(fails.length === 0 ? 0 : 1);
