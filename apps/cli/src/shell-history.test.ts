import { describe, expect, it } from "vitest";

import { parseShellHistory, selectShellCommands } from "./shell-history.js";

const tokens = (q: string): Set<string> => new Set(q.toLowerCase().split(/[^a-z0-9]+/u).filter((t) => t.length > 1));

describe("parseShellHistory", () => {
  it("parses zsh EXTENDED format (strips the `: ts:dur;` prefix)", () => {
    const raw = ": 1700000000:0;git status\n: 1700000005:3;docker run -p 8080:80 nginx";
    expect(parseShellHistory(raw)).toEqual(["git status", "docker run -p 8080:80 nginx"]);
  });

  it("parses plain one-command-per-line and drops blanks", () => {
    expect(parseShellHistory("ls -la\n\n  npm test  \n")).toEqual(["ls -la", "npm test"]);
  });

  it("joins a trailing-backslash continuation", () => {
    expect(parseShellHistory("docker build \\\n  -t app .")).toEqual(["docker build \n  -t app ."]);
  });
});

describe("selectShellCommands — query→command relevance (newest-first on ties, deduped)", () => {
  const cmds = ["git status", "docker run -p 8080:80 nginx", "docker run -p 8080:80 nginx", "kubectl get pods"];

  it("returns commands overlapping the question", () => {
    expect(selectShellCommands(cmds, tokens("what was my docker nginx command")))
      .toEqual(["docker run -p 8080:80 nginx"]); // matched + de-duplicated
  });

  it("returns [] when nothing overlaps (→ honest refusal) and for an empty query", () => {
    expect(selectShellCommands(cmds, tokens("what is the weather"))).toEqual([]);
    expect(selectShellCommands(cmds, new Set())).toEqual([]);
  });

  it("caps the result to max", () => {
    const many = Array.from({ length: 10 }, (_u, i) => `deploy service-${i.toString()}`);
    expect(selectShellCommands(many, tokens("deploy"), 3)).toHaveLength(3);
  });
});
