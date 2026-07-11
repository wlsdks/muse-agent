/**
 * "What did I do?" activity grounding for `muse ask`, lifted out of the commands-ask
 * god-file: shell-history commands (--shell, secrets-redacted), the current repo's
 * git HEAD reflog (--git, read as a file — no spawn), and Muse's own action log
 * (default-on). Each reads a FILE (never the runner's execution path), is gated by
 * its flag, and is fail-soft — a missing/unreadable source contributes no block.
 */

import { lexicalTokens } from "@muse/agent-core";
import { buildActionContextBlock, buildGitContextBlock, buildShellContextBlock } from "./context-blocks.js";
import { selectGroundingActions } from "./select.js";
import { redactSecretsInText } from "@muse/shared";
import { readActionLog, type ActionLogEntry } from "@muse/stores";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { rescueActionsCrossLingual } from "./ask-cross-lingual.js";
import { parseGitReflog, selectGitCommits, type GitCommit } from "./git-reflog.js";
import { parseShellHistory, selectShellCommands } from "./shell-history.js";

export interface ActivityGrounding {
  readonly matchedCommands: readonly string[];
  readonly shellBlock: string;
  readonly matchedCommits: readonly GitCommit[];
  readonly gitBlock: string;
  readonly matchedActions: readonly ActionLogEntry[];
  readonly actionBlock: string;
}

export async function buildActivityGrounding(params: {
  readonly query: string;
  readonly embedModel: string;
  readonly shell: boolean;
  readonly git: boolean;
  readonly actions: boolean;
  /** Resolved action-log path (autoconfigure owns resolution above this package). */
  readonly actionLogFile: string;
  /** Embed via the caller's resolved endpoint (the CLI binds the models.json merge). */
  readonly embedFn: (text: string, model: string) => Promise<number[]>;
}): Promise<ActivityGrounding> {
  const { query, embedModel, shell, git, actions, actionLogFile, embedFn } = params;

  // OPT-IN shell grounding: read the user's history FILE (no spawn) only when
  // --shell is passed; secrets are redacted before they reach the prompt.
  let matchedCommands: readonly string[] = [];
  if (shell) {
    try {
      const histFile = process.env.MUSE_SHELL_HISTORY_FILE?.trim()
        || process.env.HISTFILE?.trim()
        || join(homedir(), ".zsh_history");
      const raw = await readFile(histFile, "utf8");
      matchedCommands = selectShellCommands(parseShellHistory(raw), lexicalTokens(query))
        .map((cmd) => redactSecretsInText(cmd));
    } catch {
      // no history file / unreadable — silently skip
    }
  }
  const shellBlock = buildShellContextBlock(matchedCommands);

  // OPT-IN git grounding: read the current repo's HEAD reflog as a FILE (no spawn)
  // ONLY when --git is passed. The build* helper embeds the canonical
  // `[commit: <subject>]` hint so the model cites the subject the gate accepts.
  let matchedCommits: readonly GitCommit[] = [];
  if (git) {
    try {
      const reflogFile = process.env.MUSE_GIT_REFLOG_FILE?.trim()
        || join(process.cwd(), ".git", "logs", "HEAD");
      const raw = await readFile(reflogFile, "utf8");
      matchedCommits = selectGitCommits(parseGitReflog(raw), lexicalTokens(query));
    } catch {
      // not a git repo / unreadable — silently skip
    }
  }
  const gitBlock = buildGitContextBlock(matchedCommits);

  // Action-log grounding: "did you send that? / what have you done on my behalf?"
  // — answer from Muse's OWN record of acts taken, matched by query overlap.
  // The user's local audit trail, default-on. Cross-lingual rescue when lexical empty.
  let matchedActions: readonly ActionLogEntry[] = [];
  if (actions) {
    try {
      const all = await readActionLog(actionLogFile);
      matchedActions = selectGroundingActions(all, query);
      if (matchedActions.length === 0 && all.length > 0) {
        try {
          matchedActions = await rescueActionsCrossLingual(all, query, (t) => embedFn(t, embedModel));
        } catch { /* embed unavailable — keep lexical-empty result */ }
      }
    } catch {
      // action log missing or unreadable — silently skip
    }
  }
  const actionBlock = buildActionContextBlock(matchedActions);

  return { actionBlock, gitBlock, matchedActions, matchedCommands, matchedCommits, shellBlock };
}
