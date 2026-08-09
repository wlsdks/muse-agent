import { describe, expect, it } from "vitest";

import {
  applyAutomationHonesty,
  AUTOMATION_CORRECTION_BLOCK_KO,
  AUTOMATION_GUIDANCE_BLOCK_KO,
  detectFalseSchedulingClaim,
  detectRecurringAutomationIntent,
  detectUnsupportedRecurringAutomationIntent
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
    expect(detectRecurringAutomationIntent("나는 매일 아침 일정을 확인해")).toBe(false);
    expect(detectRecurringAutomationIntent("매일 아침 9시에 나는 오늘 일정을 확인해")).toBe(false);
    expect(detectRecurringAutomationIntent("매일 아침 9시에 나는 오늘 일정을 요약해")).toBe(false);
    expect(detectRecurringAutomationIntent("매일 아침 9시에 나는 가족에게 일정을 보내")).toBe(false);
    expect(detectRecurringAutomationIntent("I check my calendar daily")).toBe(false);
    expect(detectRecurringAutomationIntent("Daily at 9am I check my calendar")).toBe(false);
    expect(detectRecurringAutomationIntent("Daily at 9am I summarize my calendar")).toBe(false);
    expect(detectRecurringAutomationIntent("Daily at 9am I send my calendar summary")).toBe(false);
    expect(detectRecurringAutomationIntent("Daily at 9am I always summarize my calendar")).toBe(false);
    expect(detectRecurringAutomationIntent("Daily at 9am I regularly send my calendar summary")).toBe(false);
    expect(detectRecurringAutomationIntent("Daily at 9am I typically create a calendar digest")).toBe(false);
    expect(detectRecurringAutomationIntent("Daily at 9am I automatically schedule my calendar review")).toBe(false);
    expect(detectRecurringAutomationIntent("매일 아침 9시에 나는 오늘 일정을 요약한다")).toBe(false);
    expect(detectRecurringAutomationIntent("매일 아침 9시에 나는 일정 요약을 만든다")).toBe(false);
  });

  it("keeps explicit commands that use the same action verbs", () => {
    expect(detectRecurringAutomationIntent("매일 아침 9시에 오늘 일정을 요약해줘")).toBe(true);
    expect(detectRecurringAutomationIntent("매일 아침 9시에 가족에게 일정을 보내줘")).toBe(true);
    expect(detectRecurringAutomationIntent("Daily at 9am summarize my calendar")).toBe(true);
    expect(detectRecurringAutomationIntent("Daily at 9am send my calendar summary")).toBe(true);
    expect(detectRecurringAutomationIntent("Daily at 9am I want you to summarize my calendar")).toBe(true);
    expect(detectRecurringAutomationIntent("매일 아침 9시에 나는 오늘 일정 요약해줘")).toBe(true);
    expect(detectRecurringAutomationIntent("제가 놓치니 매일 오전 9시에 일정 요약을 부탁드립니다")).toBe(true);
    expect(detectRecurringAutomationIntent("나는 바쁘니까 매일 아침 9시에 일정 요약 좀 부탁할게")).toBe(true);
  });

  it("is FALSE for an unrelated recurring-time mention with no request verb", () => {
    expect(detectRecurringAutomationIntent("매주 화요일에 회의가 있어")).toBe(false);
  });

  it("is FALSE for unrelated small talk", () => {
    expect(detectRecurringAutomationIntent("오늘 날씨 어때?")).toBe(false);
  });
});

describe("detectUnsupportedRecurringAutomationIntent", () => {
  it("finds an unsupported automation beside a supported recurring reminder", () => {
    expect(detectUnsupportedRecurringAutomationIntent(
      "매일 아침 8시에 혈압약 먹는 거 잊지 마. 그리고 매일 아침 9시에 오늘 일정 요약 자동화도 만들어줘"
    )).toBe(true);
  });

  it("separates Korean and English connector-delimited mixed intents without sentence punctuation", () => {
    expect(detectUnsupportedRecurringAutomationIntent(
      "매일 아침 8시에 혈압약 먹는 거 잊지 마 그리고 매일 아침 9시에 오늘 일정 요약 자동화도 만들어줘"
    )).toBe(true);
    expect(detectUnsupportedRecurringAutomationIntent(
      "remind me every day at 8am to take meds, and create a daily automation that summarizes my calendar"
    )).toBe(true);
    expect(detectUnsupportedRecurringAutomationIntent(
      "매일 아침 8시에 혈압약 먹는 거 잊지 말고 매일 아침 9시에 오늘 일정 요약 자동화도 만들어줘"
    )).toBe(true);
    expect(detectUnsupportedRecurringAutomationIntent(
      "remind me every day at 8am to take meds then create a daily automation that summarizes my calendar"
    )).toBe(true);
  });

  it("does not classify a recurring reminder as an unsupported automation", () => {
    expect(detectUnsupportedRecurringAutomationIntent("매일 아침 8시에 혈압약 잊지 않게 알려줘")).toBe(false);
  });

  it("finds ordinary recurring action imperatives beside a supported reminder", () => {
    expect(detectUnsupportedRecurringAutomationIntent(
      "매일 아침 8시에 약 먹는 거 잊지 말고 매일 아침 9시에 오늘 일정 확인해"
    )).toBe(true);
    expect(detectUnsupportedRecurringAutomationIntent(
      "remind me every day at 8am to take meds daily at 9am check my calendar"
    )).toBe(true);
  });

  it("keeps an earlier purpose-marked notification in a trailing-verb reminder", () => {
    expect(detectUnsupportedRecurringAutomationIntent(
      "매일 아침 8시에 약 먹으라고 알려주고 매일 밤 9시에 스트레칭하라고 알려주는 거 잊지 마"
    )).toBe(false);
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

  it("leaves a supported recurring followup unchanged only with persisted scheduling evidence", () => {
    const userText = "매일 아침 8시에 혈압약 잊지 않게 알려줘";
    const replyText = "알았어!";
    const result = applyAutomationHonesty({
      replyText,
      supportedRecurringFollowupScheduled: true,
      userText
    });
    expect(result).toEqual({ builderHint: null, content: replyText });
  });

  it("retains Builder guidance for an unsupported automation in the same turn as a persisted recurring followup", () => {
    const userText = "매일 아침 8시에 혈압약 먹는 거 잊지 마. 그리고 매일 아침 9시에 오늘 일정 요약 자동화도 만들어줘";
    const replyText = "알았어!";
    const result = applyAutomationHonesty({
      replyText,
      supportedRecurringFollowupScheduled: true,
      userText
    });
    expect(result.content).toBe(`${replyText}\n\n${AUTOMATION_GUIDANCE_BLOCK_KO}`);
    expect(result.builderHint).toBe(userText);
  });

  it("corrects a false automation claim even when a different recurring followup was persisted", () => {
    const userText = "매일 아침 8시에 혈압약 먹는 거 잊지 마. 그리고 매일 아침 9시에 오늘 일정 요약 자동화도 만들어줘";
    const replyText = "일정 요약 자동화 규칙을 등록해뒀어요.";
    const result = applyAutomationHonesty({
      replyText,
      supportedRecurringFollowupScheduled: true,
      userText
    });
    expect(result.content).toBe(`${replyText}\n\n${AUTOMATION_CORRECTION_BLOCK_KO}`);
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
