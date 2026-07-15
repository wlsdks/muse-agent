import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { readWeaknesses, recordWeakness } from "@muse/stores";
import type { KnowledgeMatch } from "@muse/agent-core";

import { createTuiChatSubmitter, emptyAnswerFallback, filterFactsToKeys, formatNotesOverview, formatReminderList, formatTaskList, parseAgentMode, recordChatTurnWeakness, recordChatWeaknessForTurn } from "./chat-repl.js";
import { chatMisgroundingFraction, chatWeaknessAxis } from "./chat-grounding.js";
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

describe("chat misgrounding weakness fuel (GROUNDED != TRUE parity with ASK)", () => {
  // The retrieved source supports ONE sentence but NOT the firmware/renewal claims
  // the answer goes on to assert — a PARTIAL grounding (band [0.5,1)): the real
  // misgrounding shape, distinct from a fully-unsupported cross-lingual artifact.
  const matches: readonly KnowledgeMatch[] = [
    { cosine: 0.9, score: 0.9, source: "office_vpn.md", text: "the office vpn mtu is 1500 bytes for the seoul gateway" }
  ];
  const misgroundedAnswer =
    "The office vpn mtu is 1500 bytes. The gateway firmware version is alpha nine. " +
    "The renewal occurs every fiscal quarter automatically without notice.";

  it("chatMisgroundingFraction lands in the misgrounding band for an unsupported answer", () => {
    const fraction = chatMisgroundingFraction(misgroundedAnswer, matches);
    expect(fraction).toBeGreaterThanOrEqual(0.5);
    expect(fraction).toBeLessThan(1);
  });

  it("classifies a non-refusal answer whose cited sources don't support it as `misgrounding`", () => {
    expect(chatWeaknessAxis({ refusal: false, unbackedAction: false, answer: misgroundedAnswer, matches })).toBe("misgrounding");
  });

  it("writes a `misgrounding` ROW to the weakness ledger for a misgrounded non-refusal turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-misground-"));
    const file = join(dir, "weaknesses.json");
    const count = await recordChatWeaknessForTurn(
      { message: "what is the office vpn mtu?", answer: misgroundedAnswer, matches, refusal: false, unbackedAction: false },
      { recordWeakness, weaknessesFile: file }
    );
    expect(count).toBeGreaterThanOrEqual(1);
    const ledger = await readWeaknesses(file);
    // assert the ledger STATE — a misgrounding row exists, not that a fn was called
    expect(ledger.some((entry) => entry.axis === "misgrounding")).toBe(true);
    expect(ledger.some((entry) => entry.axis === "grounding-gap")).toBe(false);
  });

  it("PARITY NEGATIVE — a fully-supported grounded answer writes NOTHING", async () => {
    const supportingMatches: readonly KnowledgeMatch[] = [
      { cosine: 0.9, score: 0.9, source: "office_vpn.md", text: "office vpn mtu 1500 bytes gateway firmware alpha renewal quarterly automatic" }
    ];
    expect(chatWeaknessAxis({ refusal: false, unbackedAction: false, answer: misgroundedAnswer, matches: supportingMatches })).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-supported-"));
    const file = join(dir, "weaknesses.json");
    const count = await recordChatWeaknessForTurn(
      { message: "what is the office vpn mtu?", answer: misgroundedAnswer, matches: supportingMatches, refusal: false, unbackedAction: false },
      { recordWeakness, weaknessesFile: file }
    );
    expect(count).toBeUndefined();
    const ledger = await readWeaknesses(file).catch(() => []);
    expect(ledger).toHaveLength(0);
  });

  it("PARITY NEGATIVE — a cross-lingual artifact (fraction == 1.0) stays grounded, writes NOTHING", () => {
    // A KO answer over an EN note: every assertive sentence is lexically-0 ⇒ fraction 1.0.
    const koAnswer = "사무실 VPN MTU는 1380입니다. 게이트웨이는 매일 재시작됩니다.";
    const enMatches: readonly KnowledgeMatch[] = [
      { cosine: 0.9, score: 0.9, source: "vpn.md", text: "completely unrelated english evidence words only" }
    ];
    expect(chatMisgroundingFraction(koAnswer, enMatches)).toBe(1);
    expect(chatWeaknessAxis({ refusal: false, unbackedAction: false, answer: koAnswer, matches: enMatches })).toBeNull();
  });

  it("PARITY NEGATIVE — a refusal is a `grounding-gap`, never `misgrounding`", () => {
    expect(chatWeaknessAxis({ refusal: true, unbackedAction: false, answer: "I don't have that recorded yet.", matches })).toBe("grounding-gap");
  });

  it("PRECEDENCE — an unbacked action outranks a misgrounding", () => {
    expect(chatWeaknessAxis({ refusal: false, unbackedAction: true, answer: misgroundedAnswer, matches })).toBe("unbacked-action");
  });
});

describe("recordChatTurnWeakness — Ink-chat parity with runLocalChat's inline classify→persist→resolve→nudge sequence (the interactive Ink surface never ran this before)", () => {
  const savedWeaknessesFile = process.env.MUSE_WEAKNESSES_FILE;

  afterEach(() => {
    if (savedWeaknessesFile === undefined) delete process.env.MUSE_WEAKNESSES_FILE;
    else process.env.MUSE_WEAKNESSES_FILE = savedWeaknessesFile;
  });

  function tempWeaknessesFile(): string {
    const file = join(mkdtempSync(join(tmpdir(), "muse-chat-turn-weakness-")), "weaknesses.json");
    process.env.MUSE_WEAKNESSES_FILE = file;
    return file;
  }

  it("records a `grounding-gap` row for a refused personal-fact turn", async () => {
    const file = tempWeaknessesFile();
    await recordChatTurnWeakness({ answer: "잘 모르겠어요.", matches: [], question: "내 여권 갱신일이 언제야?" });
    const ledger = await readWeaknesses(file);
    expect(ledger.some((entry) => entry.axis === "grounding-gap")).toBe(true);
  });

  it("records an `unbacked-action` row when the answer claims a done action no tool actually ran", async () => {
    const file = tempWeaknessesFile();
    await recordChatTurnWeakness({ answer: "I fixed the bug.", matches: [], question: "fix the bug in add.ts", toolsUsed: [] });
    const ledger = await readWeaknesses(file);
    expect(ledger.some((entry) => entry.axis === "unbacked-action")).toBe(true);
  });

  it("writes NOTHING and returns no nudge for a casual turn with no failure signal", async () => {
    const file = tempWeaknessesFile();
    const nudge = await recordChatTurnWeakness({ answer: "Hey! Not much, just here to help.", matches: [], question: "hey, what's up?" });
    expect(nudge).toBeUndefined();
    const ledger = await readWeaknesses(file).catch(() => []);
    expect(ledger).toHaveLength(0);
  });

  it("PARITY NEGATIVE — a fully-supported grounded answer writes NOTHING (mirrors recordChatWeaknessForTurn)", async () => {
    const file = tempWeaknessesFile();
    const supportingMatches: readonly KnowledgeMatch[] = [
      { cosine: 0.9, score: 0.9, source: "office_vpn.md", text: "the office vpn mtu is 1500 bytes for the seoul gateway" }
    ];
    await recordChatTurnWeakness({ answer: "The office vpn mtu is 1500 bytes.", matches: supportingMatches, question: "what is the office vpn mtu?" });
    const ledger = await readWeaknesses(file).catch(() => []);
    expect(ledger).toHaveLength(0);
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

  it("rejects an unknown mode with a `did you mean` hint for a near-miss typo", () => {
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

describe("formatReminderList (in-chat) — overdue parity with `muse remind list`", () => {
  it("appends a localized overdue marker (EN) and leaves upcoming ones unmarked", () => {
    const out = formatReminderList([
      { text: "알람", dueLocal: "2026-06-06 12:31", overdue: true },
      { text: "약 먹기", dueLocal: "2026-07-01 09:00", overdue: false }
    ], false);
    expect(out).toContain("• 알람 — 2026-06-06 12:31 (⚠ overdue)");
    expect(out).toContain("• 약 먹기 — 2026-07-01 09:00");
    expect(out).not.toContain("약 먹기 — 2026-07-01 09:00 (⚠");
  });

  it("uses the Korean overdue marker when korean=true", () => {
    const out = formatReminderList([{ text: "운동", dueLocal: "2026-06-07 19:00", overdue: true }], true);
    expect(out).toContain("• 운동 — 2026-06-07 19:00 (⚠ 지남)");
  });
});
