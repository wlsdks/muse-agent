#!/usr/bin/env node
/**
 * Background worker that `muse job run` detaches by default.
 * Reads --job-* CLI args, runs the prompt through the local agent
 * runtime, streams progress to a per-job JSONL file, exits.
 *
 * Decoupled from program.ts so a fresh Node process boots fast —
 * no need to load every command. Streams via modelProvider when
 * --no-tools is passed (token-by-token), otherwise agentRuntime.run.
 */

import { appendFile } from "node:fs/promises";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { isRecord } from "@muse/shared";

import { scrubJobEvent } from "./job-event-scrub.js";

interface ParsedArgs {
  readonly jobId: string;
  readonly jobFile: string;
  readonly prompt: string;
  readonly model?: string;
  readonly user?: string;
  readonly persona?: string;
  readonly noTools: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    jobId: get("job-id") ?? "unknown",
    jobFile: get("job-file") ?? "/dev/null",
    prompt: get("job-prompt") ?? "",
    model: get("job-model"),
    user: get("job-user"),
    persona: get("job-persona"),
    noTools: argv.includes("--job-no-tools")
  };
}

async function appendEvent(file: string, event: Record<string, unknown>): Promise<void> {
  // Scrub before the JSONL write so a leaked secret in the prompt
  // or model output doesn't persist and replay via `job tail`.
  const scrubbed = scrubJobEvent(event);
  await appendFile(
    file,
    `${JSON.stringify({ ...scrubbed, tsIso: new Date().toISOString() })}\n`,
    { mode: 0o600 }
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt || !args.jobFile) {
    process.stderr.write("job-worker: missing --job-prompt or --job-file\n");
    process.exit(2);
  }

  if (args.model && !process.env.MUSE_MODEL) {
    process.env.MUSE_MODEL = args.model;
    if (args.model.startsWith("ollama/") && !process.env.MUSE_MODEL_PROVIDER_ID) {
      process.env.MUSE_MODEL_PROVIDER_ID = "ollama";
    }
  }

  await appendEvent(args.jobFile, {
    model: args.model,
    prompt: args.prompt,
    type: "started",
    userKey: args.user && args.persona ? `${args.user}@${args.persona}` : args.user
  });

  try {
    const assembly = createMuseRuntimeAssembly();
    if (!assembly.agentRuntime) {
      throw new Error("agentRuntime not available — set MUSE_MODEL");
    }
    const model = args.model ?? assembly.defaultModel ?? "default";

    if (args.noTools && assembly.modelProvider) {
      // Chat-only fast path: stream tokens straight to the JSONL.
      for await (const event of assembly.modelProvider.stream({
        messages: [{ content: args.prompt, role: "user" }],
        model
      })) {
        if (event.type === "error") {
          // A provider error event is not an exception; without
          // this the loop ends, the job is recorded `done` with
          // no output, and the worker exits 0 — a false success.
          const err = isRecord(event) ? event.error : undefined;
          throw err instanceof Error
            ? err
            : new Error(typeof err === "string" ? err : "model stream failed");
        }
        if (event.type === "text-delta") {
          const text = isRecord(event) && typeof event.text === "string" ? event.text : undefined;
          if (typeof text === "string" && text.length > 0) {
            await appendEvent(args.jobFile, { text, type: "progress" });
          }
        }
      }
    } else {
      const result = await assembly.agentRuntime.run({
        messages: [{ content: args.prompt, role: "user" }],
        ...(args.noTools ? { metadata: { maxTools: 0 } } : {}),
        model
      });
      await appendEvent(args.jobFile, { text: result.response.output, type: "result" });
    }

    await appendEvent(args.jobFile, { type: "done" });
  } catch (cause) {
    await appendEvent(args.jobFile, {
      text: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
      type: "error"
    });
    process.exit(1);
  }
}

await main();
