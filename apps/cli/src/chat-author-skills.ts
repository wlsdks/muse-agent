/**
 * Session-end skill authoring. Reads the just-finished session, detects
 * procedural user corrections, asks the local model to generalise each into
 * a reusable SKILL.md, and writes it execute-gated to the authored skills
 * dir (picked up next session). Mirrors distillSessionCorrections: injectable
 * I/O, fail-soft, typed skip reason. The two are complementary — distillation
 * records a one-line playbook PREFERENCE; this records a multi-step PROCEDURE.
 */

import {
  detectSkillCandidates,
  draftSkillFromSignal,
  extractCurrentSessionTurns,
  type DraftSkillOptions,
  type SessionBoundaryRef,
  type SessionTurnLine
} from "@muse/agent-core";
import { resolveAuthoredSkillsDir } from "@muse/autoconfigure";
import { AuthoredSkillStore } from "@muse/skills";

import { readLastChatHistory, readSessionBoundaries } from "./chat-history.js";

type ModelProviderLike = DraftSkillOptions["modelProvider"];

export interface AuthorSkillsOptions {
  readonly modelProvider: ModelProviderLike;
  readonly model: string;
  readonly authoredDir?: string;
  readonly maxCandidates?: number;
  readonly readEnv?: () => NodeJS.ProcessEnv;
  readonly readLines?: () => Promise<readonly SessionTurnLine[]>;
  readonly readBoundaries?: () => Promise<readonly SessionBoundaryRef[]>;
  readonly existingNames?: () => readonly string[];
}

export type AuthorResult =
  | { readonly status: "authored"; readonly skills: readonly string[] }
  | { readonly status: "skipped"; readonly reason: string };

export async function authorSkillsFromSession(options: AuthorSkillsOptions): Promise<AuthorResult> {
  const readLines = options.readLines ?? readLastChatHistory;
  const readBoundaries = options.readBoundaries ?? readSessionBoundaries;
  const env = (options.readEnv ?? (() => process.env))();

  let lines: readonly SessionTurnLine[];
  let boundaries: readonly SessionBoundaryRef[];
  try {
    [lines, boundaries] = await Promise.all([readLines(), readBoundaries()]);
  } catch (cause) {
    return { reason: `history read failed: ${cause instanceof Error ? cause.message : String(cause)}`, status: "skipped" };
  }

  const range = extractCurrentSessionTurns(lines, boundaries);
  if (!range) {
    return { reason: "no current-session range", status: "skipped" };
  }

  const signals = detectSkillCandidates(range.turns, { maxCandidates: options.maxCandidates ?? 2 });
  if (signals.length === 0) {
    return { reason: "no procedural corrections this session", status: "skipped" };
  }

  const dir = options.authoredDir ?? resolveAuthoredSkillsDir(env as Record<string, string | undefined>);
  const store = new AuthoredSkillStore({
    dir,
    ...(options.existingNames ? { existingNames: options.existingNames } : {})
  });
  const authored: string[] = [];
  for (const signal of signals) {
    const draft = await draftSkillFromSignal(signal, { model: options.model, modelProvider: options.modelProvider });
    if (!draft) {
      continue;
    }
    try {
      const { action, skill } = await store.writeOrPatch(draft);
      // Only create/patch become active learned skills; "skip" is a no-op and
      // "quarantined" was flagged risky and parked in .quarantine, never active.
      if (action === "create" || action === "patch") {
        authored.push(`${skill.name} (${action})`);
      }
    } catch {
      // fail-soft per skill — one bad write must not lose the rest
    }
  }

  if (authored.length === 0) {
    return { reason: "nothing new authored (all NONE / duplicates)", status: "skipped" };
  }
  return { skills: authored, status: "authored" };
}
