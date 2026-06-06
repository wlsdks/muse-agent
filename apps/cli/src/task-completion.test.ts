import { describe, expect, it } from "vitest";

import { isTaskCompletionReport, matchCompletedTask } from "./task-completion.js";

describe("isTaskCompletionReport", () => {
  it("flags a past-tense report of finishing a task", () => {
    expect(isTaskCompletionReport("빨래 다 했어")).toBe(true);
    expect(isTaskCompletionReport("운동 끝냈어")).toBe(true);
    expect(isTaskCompletionReport("보고서 완료했어")).toBe(true);
    expect(isTaskCompletionReport("I'm done with the laundry")).toBe(true);
  });
  it("does NOT flag a negation / not-yet / almost", () => {
    expect(isTaskCompletionReport("빨래 거의 다 했어")).toBe(false);
    expect(isTaskCompletionReport("빨래 아직 안 했어")).toBe(false);
    expect(isTaskCompletionReport("이거 해야 해")).toBe(false);
  });
  it("does NOT flag a question or a different intent", () => {
    expect(isTaskCompletionReport("빨래 다 했나?")).toBe(false);
    expect(isTaskCompletionReport("빨래 할 일에 추가해줘")).toBe(false);
    expect(isTaskCompletionReport("할 일 보여줘")).toBe(false);
  });
});

describe("matchCompletedTask", () => {
  it("returns the single open task whose title-word is in the message", () => {
    expect(matchCompletedTask("빨래 다 했어", ["빨래 개기", "우유 사기"])).toBe(0);
  });
  it("returns null when nothing matches", () => {
    expect(matchCompletedTask("운동 다 했어", ["빨래 개기", "우유 사기"])).toBeNull();
  });
  it("returns null when AMBIGUOUS (never guess which of several)", () => {
    expect(matchCompletedTask("빨래 다 했어", ["빨래 개기", "빨래 널기"])).toBeNull();
  });
  it("ignores stopword-only overlaps (오늘/할일/…)", () => {
    expect(matchCompletedTask("오늘 다 했어", ["오늘 회의 준비"])).toBeNull();
  });
});
