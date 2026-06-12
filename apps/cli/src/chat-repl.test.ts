import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createTuiChatSubmitter, emptyAnswerFallback, filterFactsToKeys, formatNotesOverview, formatTaskList, parseAgentMode } from "./chat-repl.js";
import type { ProgramIO } from "./program.js";

describe("createTuiChatSubmitter — a FAILED chat run still leaves a success:false trace (#6 slice 6d)", () => {
  it("writes a success:false run-log entry when the chat runner throws, then re-throws the original error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-fail-"));
    const io: ProgramIO = { stderr: () => undefined, stdout: () => undefined, workspaceDir: dir };
    const submit = createTuiChatSubmitter(io, {} as unknown as Command, { local: true, model: "ollama/gemma4:12b" }, async () => {
      throw new Error("model down");
    });
    await expect(submit("hi there")).rejects.toThrow("model down"); // the original error still surfaces
    const files = readdirSync(join(dir, ".muse", "runs"));
    expect(files).toHaveLength(1); // the failed run was NOT lost
    const event = JSON.parse(readFileSync(join(dir, ".muse", "runs", files[0]!), "utf8").trim()) as Record<string, unknown>;
    expect(event.success).toBe(false); // traceable as a failure for error-analysis
    expect(event.message).toBe("hi there");
    expect(event.source).toBe("cli.local");
    expect((event.response as { error?: string }).error).toBe("model down");
  });

  it("does NOT change the success path (the runner resolves → success entry, no error field)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-ok-"));
    const io: ProgramIO = { stderr: () => undefined, stdout: () => undefined, workspaceDir: dir };
    const command = { optsWithGlobals: () => ({}) } as unknown as Command;
    const submit = createTuiChatSubmitter(io, command, { local: true }, async () => ({ runId: "r1", success: true, text: "hello" }));
    await submit("hi");
    const files = readdirSync(join(dir, ".muse", "runs"));
    const event = JSON.parse(readFileSync(join(dir, ".muse", "runs", files[0]!), "utf8").trim()) as Record<string, unknown>;
    expect(event.success).toBe(true); // success path unchanged
  });
});

describe("emptyAnswerFallback (never a blank chat bubble)", () => {
  it("gives an honest KO retry-ask for a Korean message", () => {
    const out = emptyAnswerFallback("오늘 할 일 보여줘");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("다시");
    expect(out).not.toContain("잠시"); // not a deferral
  });
  it("gives an EN retry-ask for an English message", () => {
    expect(emptyAnswerFallback("show my tasks")).toMatch(/once more|say it/i);
  });
});

describe("formatNotesOverview (deterministic corpus inventory, KO/EN)", () => {
  it("lists the notes-relative paths with a KO header + count", () => {
    const out = formatNotesOverview(["a.md", "wifi/b.md"], 2, true);
    expect(out).toContain("저장된 노트가 2개");
    expect(out).toContain("• a.md");
    expect(out).toContain("• wifi/b.md");
    expect(out).not.toContain("/Users/"); // never a home path
  });
  it("uses an EN header + 'and N more' when the list is capped", () => {
    const out = formatNotesOverview(["a.md"], 5, false);
    expect(out).toContain("You have 5 notes");
    expect(out).toContain("… and 4 more");
  });
});

describe("formatTaskList (deterministic 'what are my tasks' answer, KO/EN)", () => {
  it("lists open tasks with a KO header + their pre-rendered LOCAL due time", () => {
    const out = formatTaskList(
      [{ title: "보고서 제출", dueLocal: "Mon, Jun 8, 2026, 9:00 AM" }, { title: "우유 사기", urgent: true }],
      true
    );
    expect(out).toContain("열린 할 일이 2개");
    expect(out).toContain("• 보고서 제출 — Mon, Jun 8, 2026, 9:00 AM 마감");
    expect(out).toContain("⚡ 우유 사기"); // urgent flag, no due
    expect(out).not.toContain("T00:00"); // never a raw UTC ISO
  });
  it("says there are none when the open list is empty (KO + EN)", () => {
    expect(formatTaskList([], true)).toContain("열린 할 일이 없어요");
    expect(formatTaskList([], false)).toContain("no open tasks");
  });
});
import { factKeysToInject } from "./chat-grounding.js";

describe("factKeysToInject (per-fact topic relevance — no tangent, recall preserved)", () => {
  const keys = ["user_name", "dog_name", "dentist"];
  it("a general turn keeps only the name (drops the covered-but-unasked dog)", () => {
    expect(factKeysToInject("물 자주 마시는 게 왜 중요해?", keys)).toEqual(["user_name", "dentist"]);
  });
  it("a name-recall turn keeps the name, still drops the unrelated dog", () => {
    expect(factKeysToInject("내 이름 뭐야?", keys)).toEqual(["user_name", "dentist"]);
  });
  it("a dog-recall turn keeps the dog (recall wedge intact)", () => {
    expect(factKeysToInject("내 강아지 이름 뭐야?", keys)).toEqual(["user_name", "dog_name", "dentist"]);
  });
  it("a fact no topic covers (dentist) is always kept so its recall never breaks", () => {
    expect(factKeysToInject("좋은 아침이야", keys)).toContain("dentist");
  });
});

describe("filterFactsToKeys", () => {
  it("keeps only the allowed keys, preserving values", () => {
    expect(filterFactsToKeys({ user_name: "진안", dog_name: "보리" }, ["user_name"])).toEqual({ user_name: "진안" });
  });
});

describe("parseAgentMode", () => {
  it("returns undefined when --mode is unset", () => {
    expect(parseAgentMode(undefined)).toBeUndefined();
  });

  it("accepts the two documented modes (case + whitespace insensitive)", () => {
    expect(parseAgentMode("react")).toBe("react");
    expect(parseAgentMode("plan_execute")).toBe("plan_execute");
    expect(parseAgentMode("  REACT  ")).toBe("react");
    expect(parseAgentMode("Plan_Execute")).toBe("plan_execute");
  });

  it("rejects an unknown mode with a `did you mean` hint for a near-miss typo (goal-493 sibling)", () => {
    expect(() => parseAgentMode("reactt"))
      .toThrow(/--mode must be 'react' or 'plan_execute'.*did you mean 'react'/u);
    expect(() => parseAgentMode("plan_execut"))
      .toThrow(/did you mean 'plan_execute'/u);
  });

  it("rejects without a guess when nothing is close (no random suggestion)", () => {
    expect(() => parseAgentMode("totallydifferent"))
      .toThrow(/--mode must be 'react' or 'plan_execute' \(got 'totallydifferent'\)$/u);
  });
});
