/**
 * Read-only git grounding for `muse ask` (B3 perception, OPT-IN). "What did I
 * work on this week?", "what was that commit about the verdict?" — questions the
 * user's own git history answers. Read from `.git/logs/HEAD` (the HEAD reflog) as
 * a FILE — NO process spawn, so this stays the same low-risk class as the
 * shell-history source, never the runner's execution path. Pure parse + relevance
 * here; the file read lives at the call site. Subjects only (the reflog records
 * the commit's first line), which is what "what did I work on" needs.
 */

import { lexicalTokens } from "@muse/agent-core";

export interface GitCommit {
  /** Abbreviated (7-char) commit hash — the post-image of the reflog entry. */
  readonly hash: string;
  /** The commit subject (first line of the message). */
  readonly subject: string;
}

/**
 * Parse a `.git/logs/HEAD` reflog into commits, oldest→newest. Each line is
 * `<old> <new> <author> <email> <epoch> <tz>\t<message>`; only `commit`,
 * `commit (initial)`, and `commit (amend)` entries are kept (checkout / merge /
 * rebase / reset reflog noise is dropped). Never throws — a malformed line is
 * skipped.
 */
export function parseGitReflog(raw: string): readonly GitCommit[] {
  const out: GitCommit[] = [];
  for (const line of raw.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const message = line.slice(tab + 1);
    const subjectMatch = /^commit(?:\s*\([^)]*\))?:\s*(.+)$/su.exec(message);
    if (!subjectMatch) {
      continue;
    }
    const subject = (subjectMatch[1] ?? "").trim();
    if (subject.length === 0) {
      continue;
    }
    const newHash = line.slice(0, tab).split(/\s+/u)[1] ?? "";
    if (newHash.length < 7) {
      continue;
    }
    out.push({ hash: newHash.slice(0, 7), subject });
  }
  return out;
}

/**
 * The commits most relevant to the question — token overlap with the subject,
 * newest-first on a tie. Unlike shell history, a 0-overlap commit is NOT dropped:
 * `--git` is opt-in and the archetypal question ("what did I work on?") shares no
 * token with `feat:`/`fix:` subjects, so when nothing overlaps we still surface
 * the most RECENT `max` commits — the user explicitly asked for their git
 * context. De-duplicates identical subjects (amends / rebases repeat them).
 */
export function selectGitCommits(
  commits: readonly GitCommit[],
  queryTokens: ReadonlySet<string>,
  max = 5
): readonly GitCommit[] {
  const scored = commits
    .map((commit, index) => ({ commit, index, score: overlap(commit.subject, queryTokens) }))
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const seen = new Set<string>();
  const picked: GitCommit[] = [];
  for (const entry of scored) {
    if (seen.has(entry.commit.subject)) {
      continue;
    }
    seen.add(entry.commit.subject);
    picked.push(entry.commit);
    if (picked.length >= max) {
      break;
    }
  }
  return picked;
}

function overlap(subject: string, queryTokens: ReadonlySet<string>): number {
  const tokens = lexicalTokens(subject);
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) {
      score += 1;
    }
  }
  return score;
}
