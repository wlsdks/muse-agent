import { describe, expect, it } from "vitest";

import { detectUnscheduledRememberIntent } from "../src/remember-intent.js";

describe("detectUnscheduledRememberIntent", () => {
  it("true: a Korean remember-verb + a date-shaped phrase", () => {
    expect(detectUnscheduledRememberIntent("8월 5일 아침에 알려달라고 기억해줘")).toBe(true);
    expect(detectUnscheduledRememberIntent("내일 아침에 기억해줘")).toBe(true);
    expect(detectUnscheduledRememberIntent("30분 뒤에 잊지 말고 알려줘")).toBe(true);
    expect(detectUnscheduledRememberIntent("다음 주 월요일에 기억해줘")).toBe(true);
  });

  it("true: an English remember-verb + a date-shaped phrase", () => {
    expect(detectUnscheduledRememberIntent("remind me tomorrow morning")).toBe(true);
    expect(detectUnscheduledRememberIntent("don't forget, in 30 minutes I need to call")).toBe(true);
    expect(detectUnscheduledRememberIntent("remember to check at 9pm")).toBe(true);
    expect(detectUnscheduledRememberIntent("remind me on August 5")).toBe(true);
  });

  it("false: a remember-verb with NO date-shaped phrase", () => {
    expect(detectUnscheduledRememberIntent("기억해줘")).toBe(false);
    expect(detectUnscheduledRememberIntent("remind me")).toBe(false);
    expect(detectUnscheduledRememberIntent("이거 잊지 말고")).toBe(false);
  });

  it("false: a date-shaped phrase with NO remember-verb", () => {
    expect(detectUnscheduledRememberIntent("내일 미팅 있어")).toBe(false);
    expect(detectUnscheduledRememberIntent("tomorrow I have a meeting")).toBe(false);
  });

  it("false: plain chat / unrelated text", () => {
    expect(detectUnscheduledRememberIntent("오늘 좀 피곤하네 ㅋㅋ")).toBe(false);
    expect(detectUnscheduledRememberIntent("what's the weather like?")).toBe(false);
  });

  it("false: empty / whitespace-only text", () => {
    expect(detectUnscheduledRememberIntent("")).toBe(false);
    expect(detectUnscheduledRememberIntent("   ")).toBe(false);
  });
});
