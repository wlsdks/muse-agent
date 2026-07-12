/**
 * Interactive auth prompting, extracted from `program-helpers.ts`:
 * `resolveAuthToken` (token-or-prompt) plus the shared `@clack/prompts`
 * text/password wrappers used across the setup + auth flows.
 */

import { isCancel, password, text } from "@clack/prompts";

import type { ProgramIO } from "./program.js";

export async function resolveAuthToken(io: ProgramIO, token: string | undefined): Promise<string> {
  const trimmed = token?.trim();

  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }

  return promptPassword(io, { message: "Muse API token" });
}

export async function promptText(
  io: ProgramIO,
  options: { readonly message: string; readonly placeholder?: string }
): Promise<string> {
  const value = io.prompts
    ? await io.prompts.text(options)
    : await text(options);

  return readPromptValue(value, "Prompt was cancelled");
}

async function promptPassword(io: ProgramIO, options: { readonly message: string }): Promise<string> {
  const value = io.prompts
    ? await io.prompts.password(options)
    : await password(options);

  return readPromptValue(value, "Authentication was cancelled");
}

function readPromptValue(value: unknown, cancelMessage: string): string {
  if (isCancel(value)) {
    throw new Error(cancelMessage);
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Interactive input must not be empty");
  }

  return value.trim();
}
