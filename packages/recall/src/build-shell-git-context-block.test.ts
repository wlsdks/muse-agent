import { describe, expect, it } from "vitest";

import { buildGitContextBlock, buildShellContextBlock } from "./present.js";

describe("buildShellContextBlock — <<command N>> grounding block", () => {
  it("empty → placeholder", () => {
    expect(buildShellContextBlock([])).toBe("(no matching shell commands)");
  });
  it("wraps each command 1-based, raw, no citation hint", () => {
    const block = buildShellContextBlock(["git status", "ls -la"]);
    expect(block).toBe("<<command 1>>\ngit status\n<<end>>\n\n<<command 2>>\nls -la\n<<end>>");
  });
});

describe("buildGitContextBlock — <<commit N>> grounding block", () => {
  it("empty → placeholder", () => {
    expect(buildGitContextBlock([])).toBe("(no matching git commits)");
  });
  it("wraps each commit with hash header + [commit: <subject>] citation (subject, not hash)", () => {
    const block = buildGitContextBlock([{ hash: "abc123", subject: "fix the bug" }]);
    expect(block).toBe("<<commit 1 — abc123>>\nfix the bug\n[commit: fix the bug]\n<<end>>");
    expect(block).not.toContain("[commit: abc123]");
  });
  it("separates multiple commits with a blank line", () => {
    const block = buildGitContextBlock([{ hash: "a", subject: "x" }, { hash: "b", subject: "y" }]);
    expect(block).toContain("<<end>>\n\n<<commit 2");
  });
});
