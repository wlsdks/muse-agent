/**
 * The "no model configured yet" message every LLM-backed command hits when
 * neither MUSE_MODEL/config nor --model resolves a provider (E4b audit
 * systemic #1 — this exact sentence was hand-duplicated across ask/brief/
 * notes-rag/read, each pointing only at a bare env var). Centralized so the
 * fix — point at `muse setup local` / `muse onboard`, not a bare env-var name
 * — lands once for every call site, in both catalog languages.
 */

import { resolveCliLanguage, t } from "./cli-i18n.js";
import { readConfigStore } from "./program-config.js";
import type { ProgramIO } from "./program.js";
import { setCliTerminalState } from "./cli-terminal-state.js";

/**
 * Resolves the CLI language, writes the localized message to stderr, and
 * sets `process.exitCode = 2` — the shared convention across every call site
 * this replaces (ask/brief/notes-rag/read/remember all used exitCode 2).
 */
export async function reportNoModelConfigured(
  io: ProgramIO,
  env: Readonly<Record<string, string | undefined>>,
  command: string
): Promise<void> {
  await resolveCliLanguage(env, () => readConfigStore(io));
  io.stderr(`${t("model.notConfigured", { command })}\n`);
  setCliTerminalState("user-error");
}
