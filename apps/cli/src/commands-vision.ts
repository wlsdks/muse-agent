/**
 * `muse vision <image>` — local image description via Ollama
 * vision models (`llama3.2-vision`, `llava`, ...).
 *
 * Goal 087 — first JARVIS-class sensory input for Muse. The
 * model lives on the user's machine; the only HTTP call is
 * `POST <ollamaUrl>/api/generate` with the image as a single
 * base64 entry in the `images` array. No new dep, no cloud
 * round-trip.
 *
 * Inputs:
 *   - <path>            local file
 *   - http(s)://...     URL (fetched, buffered, base64-encoded)
 *   - data:image/...    inline data URL (passed through)
 *
 * Fails-soft on a missing Ollama with a one-line hint pointing
 * at `ollama serve` + `ollama pull llama3.2-vision`.
 */

import { readFile } from "node:fs/promises";

import type { Command } from "commander";

import { resolveOllamaUrl } from "./ollama-url.js";
import type { ProgramIO } from "./program.js";

interface VisionOptions {
  readonly prompt?: string;
  readonly model?: string;
  readonly json?: boolean;
}

const DEFAULT_VISION_MODEL = "llama3.2-vision:latest";
const DEFAULT_PROMPT = "Describe this image in 2-3 sentences. Note any notable text, objects, or context.";

/**
 * Goal 087 — pick the model the user expects:
 *   1. explicit `--model`
 *   2. `MUSE_VISION_MODEL` env
 *   3. `llama3.2-vision:latest` default
 *
 * Exported for direct unit-test coverage so the test can pin
 * each branch without spinning up Ollama.
 */
export function resolveVisionModel(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  const cliFlag = explicit?.trim();
  if (cliFlag && cliFlag.length > 0) return cliFlag;
  const fromEnv = env.MUSE_VISION_MODEL?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return DEFAULT_VISION_MODEL;
}

/**
 * Goal 087 — load the image into a base64 string Ollama accepts.
 * Path / URL / data-URL all reduce to "raw bytes → base64". Pure
 * (no global fetch capture) so a unit test can drive each branch
 * with an injected `fetchImpl`.
 */
export async function loadImageAsBase64(
  source: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<string> {
  const trimmed = source.trim();
  if (trimmed.startsWith("data:")) {
    // data:image/png;base64,XXXX — peel the prefix. Reject a
    // non-base64 data URL: the post-comma payload is then
    // URL-encoded text (SVG / plain), and passing it through as
    // "base64" would silently feed the vision model garbage.
    const comma = trimmed.indexOf(",");
    if (comma < 0) throw new Error("malformed data URL (no comma separator)");
    if (!/;base64$/iu.test(trimmed.slice("data:".length, comma))) {
      throw new Error(
        "data: URL must be base64-encoded image bytes (e.g. data:image/png;base64,…); " +
        "a non-base64 (URL-encoded / SVG / text) data URL is not a supported vision image"
      );
    }
    return trimmed.slice(comma + 1);
  }
  if (/^https?:\/\//iu.test(trimmed)) {
    const response = await fetchImpl(trimmed);
    if (!response.ok) {
      throw new Error(`fetch ${trimmed} returned ${response.status.toString()}`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    return buf.toString("base64");
  }
  // Local path.
  const buf = await readFile(trimmed);
  return buf.toString("base64");
}

/**
 * Goal 087 — build the JSON body Ollama's `/api/generate`
 * expects. Exported so tests can verify the shape without
 * round-tripping through the CLI runner.
 */
/**
 * Format Ollama's failure response for the user. 404 specifically
 * means "the model isn't installed" — surface the exact
 * `ollama pull <base>` command instead of just dumping the JSON
 * body. Other statuses (5xx, network rejects, etc.) keep the
 * generic shape so the operator sees the raw body for debugging.
 *
 * Exported so the test pins the 404-vs-other branching without
 * having to drive a real Ollama instance.
 */
export function formatOllamaVisionFailure(args: {
  readonly status: number;
  readonly body: string;
  readonly model: string;
}): string {
  const trimmedBody = args.body.slice(0, 200);
  if (args.status === 404) {
    const base = args.model.split(":")[0] ?? args.model;
    return (
      `muse vision: Ollama 404 — model '${args.model}' is not installed.\n` +
      `Pull it with: ollama pull ${base}\n` +
      (trimmedBody.length > 0 ? `(Ollama response: ${trimmedBody})\n` : "")
    );
  }
  return `muse vision: Ollama ${args.status.toString()} — ${trimmedBody}\n`;
}

export function buildOllamaVisionBody(args: {
  readonly model: string;
  readonly prompt: string;
  readonly imageBase64: string;
}): Record<string, unknown> {
  return {
    model: args.model,
    prompt: args.prompt,
    images: [args.imageBase64],
    stream: false,
    // Kill chain-of-thought for a Qwen3-class vision model — a
    // Qwen-only setup points MUSE_VISION_MODEL at one. `/api/generate`
    // honours `think` like `/api/chat`; non-thinking models ignore it.
    think: false
  };
}

export function registerVisionCommand(program: Command, io: ProgramIO): void {
  program
    .command("vision")
    .description("Describe a local or remote image via a local Ollama vision model")
    .argument("<source>", "Path, http(s):// URL, or data: URL")
    .option("--prompt <text>", "Override the default 'describe this image' prompt")
    .option("--model <tag>", "Ollama model id (default $MUSE_VISION_MODEL or llama3.2-vision:latest)")
    .option("--json", "Emit the raw Ollama response payload")
    .action(async (source: string, options: VisionOptions) => {
      const model = resolveVisionModel(options.model, process.env);
      const prompt = options.prompt?.trim() && options.prompt.trim().length > 0
        ? options.prompt.trim()
        : DEFAULT_PROMPT;
      let imageBase64: string;
      try {
        imageBase64 = await loadImageAsBase64(source);
      } catch (cause) {
        io.stderr(`muse vision: could not load image: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      const url = `${resolveOllamaUrl()}/api/generate`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildOllamaVisionBody({ model, prompt, imageBase64 }))
        });
      } catch (cause) {
        io.stderr(
          `muse vision: Ollama unreachable at ${url} — ` +
          `start it with \`ollama serve\` and pull the model with \`ollama pull ${model.split(":")[0]}\`.\n` +
          `(underlying error: ${cause instanceof Error ? cause.message : String(cause)})\n`
        );
        process.exitCode = 1;
        return;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        io.stderr(formatOllamaVisionFailure({ body, model, status: response.status }));
        process.exitCode = 1;
        return;
      }
      const payload = await response.json() as { response?: string; model?: string };
      const description = (payload.response ?? "").trim();
      if (options.json) {
        io.stdout(`${JSON.stringify({ model: payload.model ?? model, description }, null, 2)}\n`);
        return;
      }
      io.stdout(description.length > 0 ? `${description}\n` : "(no description returned)\n");
    });
}
