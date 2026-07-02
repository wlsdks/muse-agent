import { lexicalTokens } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { parseGitReflog, selectGitCommits } from "./git-reflog.js";

const line = (oldH: string, newH: string, msg: string): string =>
  `${oldH} ${newH} Stark <dev@x.io> 1780430344 +0900\t${msg}`;

describe("parseGitReflog — extract commit subjects from .git/logs/HEAD", () => {
  it("keeps commit / commit (initial) / commit (amend) entries, oldest→newest", () => {
    const raw = [
      line("0".repeat(40), "aaaaaaabbbbbbb", "commit (initial): chore: scaffold the repo"),
      line("aaaaaaabbbbbbb", "ccccccc1111111", "commit: feat(cli): add the ask command"),
      line("ccccccc1111111", "ddddddd2222222", "commit (amend): fix(cli): tidy the ask command")
    ].join("\n");
    const commits = parseGitReflog(raw);
    expect(commits.map((c) => c.subject)).toEqual([
      "chore: scaffold the repo",
      "feat(cli): add the ask command",
      "fix(cli): tidy the ask command"
    ]);
    expect(commits[0]?.hash).toBe("aaaaaaa"); // 7-char abbrev of the post-image hash
  });

  it("drops non-commit reflog noise (checkout / merge / rebase / reset)", () => {
    const raw = [
      line("0".repeat(40), "1111111aaaaaaa", "commit: feat: real commit"),
      line("1111111aaaaaaa", "2222222bbbbbbb", "checkout: moving from main to feature"),
      line("2222222bbbbbbb", "3333333ccccccc", "merge feature: Fast-forward"),
      line("3333333ccccccc", "4444444ddddddd", "reset: moving to HEAD~1"),
      line("4444444ddddddd", "5555555eeeeeee", "rebase (finish): returning to refs/heads/main")
    ].join("\n");
    expect(parseGitReflog(raw).map((c) => c.subject)).toEqual(["feat: real commit"]);
  });

  it("never throws on malformed lines (no tab / short hash / empty subject)", () => {
    const raw = ["garbage with no tab", line("0".repeat(40), "short", "commit: x"), `${"a".repeat(40)} ${"b".repeat(40)} who\tcommit:   `].join("\n");
    expect(parseGitReflog(raw)).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(parseGitReflog("")).toEqual([]);
  });
});

describe("selectGitCommits — relevance + recency", () => {
  const commits = [
    { hash: "1111111", subject: "feat: add the calendar perception source" },
    { hash: "2222222", subject: "fix: the grounding verdict for tasks" },
    { hash: "3333333", subject: "feat: proactive nudge quotes the relevant line" },
    { hash: "4444444", subject: "docs: update the README" }
  ];

  it("ranks a query-overlapping commit first", () => {
    const picked = selectGitCommits(commits, lexicalTokens("what did the grounding verdict fix do"), 5);
    expect(picked[0]?.subject).toBe("fix: the grounding verdict for tasks");
  });

  it("falls back to the most RECENT commits when nothing overlaps (the 'what did I work on?' case)", () => {
    const picked = selectGitCommits(commits, lexicalTokens("anything happening lately"), 2);
    // no subject shares a token → newest-first (last in reflog order = most recent)
    expect(picked.map((c) => c.subject)).toEqual([
      "docs: update the README",
      "feat: proactive nudge quotes the relevant line"
    ]);
  });

  it("caps at max and de-duplicates repeated subjects", () => {
    const dup = [...commits, { hash: "5555555", subject: "docs: update the README" }];
    const picked = selectGitCommits(dup, lexicalTokens("readme docs"), 5);
    expect(picked.filter((c) => c.subject === "docs: update the README")).toHaveLength(1);
  });
});
