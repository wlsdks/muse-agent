import { describe, expect, it } from "vitest";

import {
  applyAutomationHonesty,
  AUTOMATION_CORRECTION_BLOCK_KO,
  AUTOMATION_GUIDANCE_BLOCK_KO,
  detectFalseSchedulingClaim,
  detectRecurringAutomationIntent
} from "./chat-automation-honesty.js";

describe("detectRecurringAutomationIntent", () => {
  it("detects KO daily-time automation asks", () => {
    expect(detectRecurringAutomationIntent("매일 아침 9시에 오늘 일정 요약해주는 자동화 만들어줘")).toBe(true);
  });

  it("detects KO weekly automation asks", () => {
    expect(detectRecurringAutomationIntent("매주 월요일 아침에 할일 목록 보내줘")).toBe(true);
  });

  it("detects KO weekday-recurring asks", () => {
    expect(detectRecurringAutomationIntent("평일마다 저녁 6시에 오늘 요약 알려줘")).toBe(true);
  });

  it("detects KO interval (N분마다/N시간마다) asks", () => {
    expect(detectRecurringAutomationIntent("30분마다 새 메일 확인해서 알려줘")).toBe(true);
  });

  it("detects EN daily automation asks", () => {
    expect(detectRecurringAutomationIntent("set up a daily automation that summarizes my calendar every morning")).toBe(true);
  });

  it("detects EN weekly automation asks", () => {
    expect(detectRecurringAutomationIntent("create a rule that runs every week to send me a digest")).toBe(true);
  });

  it("detects EN hourly automation asks", () => {
    expect(detectRecurringAutomationIntent("can you schedule an hourly reminder to check my inbox")).toBe(true);
  });

  it("is FALSE for a one-shot future reminder ask (no recurring signal)", () => {
    expect(detectRecurringAutomationIntent("내일 8시에 알려줘")).toBe(false);
  });

  it("is FALSE for a one-shot EN future reminder ask", () => {
    expect(detectRecurringAutomationIntent("remind me tomorrow at 8am to call mom")).toBe(false);
  });

  it("is FALSE for a plain statement about a routine (no request verb)", () => {
    expect(detectRecurringAutomationIntent("나는 매일 아침 커피 마셔")).toBe(false);
  });

  it("is FALSE for an unrelated recurring-time mention with no request verb", () => {
    expect(detectRecurringAutomationIntent("매주 화요일에 회의가 있어")).toBe(false);
  });

  it("is FALSE for unrelated small talk", () => {
    expect(detectRecurringAutomationIntent("오늘 날씨 어때?")).toBe(false);
  });
});

describe("detectFalseSchedulingClaim", () => {
  it("detects the live-reproduced KO false claim", () => {
    expect(detectFalseSchedulingClaim("규칙을 등록해둘게요!")).toBe(true);
  });

  it("detects a KO recurring-delivery promise", () => {
    expect(detectFalseSchedulingClaim("매일 아침 요약해서 알려드릴게요")).toBe(true);
  });

  it("detects a KO 'created/set up' past-tense claim", () => {
    expect(detectFalseSchedulingClaim("자동화를 만들어뒀어요, 매일 아침 9시에 실행돼요")).toBe(true);
  });

  it("detects a KO schedule-add claim", () => {
    expect(detectFalseSchedulingClaim("스케줄에 추가했어요")).toBe(true);
  });

  it("detects an EN 'I've set up' claim", () => {
    expect(detectFalseSchedulingClaim("I've set up a daily automation for you.")).toBe(true);
  });

  it("detects an EN 'I've scheduled/created a rule' claim", () => {
    expect(detectFalseSchedulingClaim("I've created a rule that runs every morning.")).toBe(true);
  });

  it("is FALSE for plain helpful text with no registration claim", () => {
    expect(detectFalseSchedulingClaim("오늘 일정은 회의 2건과 병원 예약이 있어요.")).toBe(false);
  });

  it("is FALSE for a future-tense offer, not a completed claim", () => {
    expect(detectFalseSchedulingClaim("빌더에서 자동화를 만들어 드릴 수 있어요.")).toBe(false);
  });

  it("is FALSE for an EN answer describing an existing calendar event (not a scheduling claim)", () => {
    expect(detectFalseSchedulingClaim("You have a meeting scheduled for 3pm today.")).toBe(false);
  });

  it("is FALSE for an ordinary one-time backed appointment registration (no automation noun)", () => {
    expect(detectFalseSchedulingClaim("내일 오후 3시에 '치과 예약'을 등록했습니다.")).toBe(false);
  });

  it("is FALSE for an ordinary one-time task-add confirmation (no automation noun)", () => {
    expect(detectFalseSchedulingClaim("우유 사기를 할 일 목록에 추가했어요.")).toBe(false);
  });
});

describe("applyAutomationHonesty", () => {
  it("appends the correction block when the reply falsely claims registration, and sets builderHint", () => {
    const userText = "매일 아침 9시에 오늘 일정 요약해주는 자동화 만들어줘";
    const replyText = "네, 규칙을 등록해둘게요!";
    const result = applyAutomationHonesty({ replyText, userText });
    expect(result.content).toBe(`${replyText}\n\n${AUTOMATION_CORRECTION_BLOCK_KO}`);
    expect(result.builderHint).toBe(userText);
  });

  it("correction beats guidance when both conditions could apply", () => {
    const userText = "매일 아침 9시에 오늘 일정 요약해주는 자동화 만들어줘";
    const replyText = "규칙을 등록해둘게요!";
    const result = applyAutomationHonesty({ replyText, userText });
    expect(result.content).not.toContain(AUTOMATION_GUIDANCE_BLOCK_KO);
    expect(result.content).toContain(AUTOMATION_CORRECTION_BLOCK_KO);
  });

  it("appends the guidance block when the user asked for recurring automation and the reply made no false claim", () => {
    const userText = "매일 아침 9시에 오늘 일정 요약해주는 자동화 만들어줘";
    const replyText = "반복 일정 요약은 아직 채팅에서 바로 만들 수는 없어요.";
    const result = applyAutomationHonesty({ replyText, userText });
    expect(result.content).toBe(`${replyText}\n\n${AUTOMATION_GUIDANCE_BLOCK_KO}`);
    expect(result.builderHint).toBe(userText);
  });

  it("leaves content byte-identical and builderHint null when neither condition applies", () => {
    const userText = "오늘 날씨 어때?";
    const replyText = "오늘은 맑고 따뜻해요.";
    const result = applyAutomationHonesty({ replyText, userText });
    expect(result.content).toBe(replyText);
    expect(result.builderHint).toBeNull();
  });

  it("leaves content byte-identical for a one-shot reminder ask with a normal reply", () => {
    const userText = "내일 8시에 알려줘";
    const replyText = "네, 내일 8시에 알려드릴게요.";
    const result = applyAutomationHonesty({ replyText, userText });
    expect(result.content).toBe(replyText);
    expect(result.builderHint).toBeNull();
  });
});
