import { describe, expect, it } from "vitest";

import { actionToolRan, answerClaimsAction, answerPromisesAction, classifyActionRequest, classifyCasualPrompt, classifyContactLookup, classifyCorpusOverview, classifyMetaPrompt, classifyReminderListQuery, classifyTaskListQuery, isUnbackedActionClaim, requestsToolAction } from "../src/index.js";

describe("actionToolRan — did a STATE-CHANGING (actuator) tool run?", () => {
  it("true for an actuator verb tool / _action tool, false for read-only tools or none", () => {
    expect(actionToolRan(["muse.tasks.add"])).toBe(true);
    expect(actionToolRan(["muse.calendar.update"])).toBe(true);
    expect(actionToolRan(["web_action"])).toBe(true);
    expect(actionToolRan(["muse.tasks.list", "knowledge_search"])).toBe(false);
    expect(actionToolRan([])).toBe(false);
  });

  it("recognises the @muse/fs computer-control actuators (so a real file_edit isn't flagged as a false claim)", () => {
    for (const tool of ["file_edit", "file_write", "file_multi_edit", "file_delete", "file_move", "run_command"]) {
      expect(actionToolRan([tool])).toBe(true);
    }
    // reads are NOT state-changing — they must stay non-actuators.
    for (const tool of ["file_read", "file_grep", "file_list"]) {
      expect(actionToolRan([tool])).toBe(false);
    }
  });
});

describe("isUnbackedActionClaim — the composed false-done backstop condition (all three legs)", () => {
  it("TRUE only when a code-fix request is answered with a done-claim and NO actuator ran", () => {
    const q = "fix the bug in add.ts", a = "I fixed the bug.";
    // all three legs satisfied → a false done.
    expect(isUnbackedActionClaim({ query: q, answer: a, toolNames: [] })).toBe(true);
    expect(isUnbackedActionClaim({ query: q, answer: a, toolNames: ["file_read", "file_grep"] })).toBe(true);
    // a REAL edit ran → not unbacked (the actuator leg).
    expect(isUnbackedActionClaim({ query: q, answer: a, toolNames: ["file_edit"] })).toBe(false);
    // not an action request (no file) → the request leg is false.
    expect(isUnbackedActionClaim({ query: "what does add.ts do?", answer: a, toolNames: [] })).toBe(false);
    // the answer claims nothing → the claim leg is false.
    expect(isUnbackedActionClaim({ query: q, answer: "I read add.ts; the bug is on line 5.", toolNames: [] })).toBe(false);
  });
});

describe("classifyCasualPrompt — pure social prompts only (precision-first)", () => {
  it("classifies greetings (EN + KO), tolerating trailing punctuation and repeats", () => {
    for (const q of ["hi", "Hi!", "hello", "hey there", "HELLO", "hiii", "안녕", "안녕하세요", "good morning", "hey muse"]) {
      expect(classifyCasualPrompt(q)).toBe("greeting");
    }
  });

  it("classifies KO time-of-day greetings incl. the copula suffix (so they take the fast path, not the 7s grounded path)", () => {
    for (const q of ["좋은 아침", "좋은 아침이야", "좋은 아침이에요", "좋은 저녁이에요", "좋은 밤", "좋은 오후예요", "굿모닝"]) {
      expect(classifyCasualPrompt(q)).toBe("greeting");
    }
  });

  it("does NOT mistake a real question that merely STARTS with a time-of-day phrase for a greeting", () => {
    for (const q of ["좋은 하루 보내는 방법 알려줘", "내 아침 일정 뭐야", "좋은 아침 뭐 먹을까"]) {
      expect(classifyCasualPrompt(q)).toBeNull();
    }
  });

  it("classifies thanks (EN + KO), incl. KO 수고 variants", () => {
    for (const q of ["thanks", "Thank you", "thx", "ty", "고마워", "감사합니다", "appreciate it", "수고했어", "수고하셨어요", "수고"]) {
      expect(classifyCasualPrompt(q)).toBe("thanks");
    }
  });

  it("classifies farewells (EN + KO), incl. KO good-night 잘 자 / 굿나잇", () => {
    for (const q of ["bye", "goodbye", "see you", "take care", "잘가", "안녕히 계세요", "잘 자", "잘자요", "굿나잇", "푹 자요"]) {
      expect(classifyCasualPrompt(q)).toBe("farewell");
    }
  });

  it("does NOT mistake a real request that merely STARTS with a farewell/thanks word", () => {
    for (const q of ["잘 자는 방법 알려줘", "수고했어 오늘 일정 정리해줘", "잘 자라고 알람 맞춰줘"]) {
      expect(classifyCasualPrompt(q)).toBeNull();
    }
  });

  it("returns null for a real question — even when it OPENS with a social word", () => {
    for (const q of [
      "what is my monthly rent?",
      "hi, what's my MTU?",
      "thanks — when is the dentist cleaning?",
      "hello world program in rust",
      "who is my landlord",
      "bye-bye script: what does it do?",
      "thank you note template for the wedding"
    ]) {
      expect(classifyCasualPrompt(q)).toBeNull();
    }
  });

  it("returns null for empty / whitespace input", () => {
    expect(classifyCasualPrompt("")).toBeNull();
    expect(classifyCasualPrompt("   ")).toBeNull();
  });

  it("never misclassifies a long prompt as casual (the 30-char content guard)", () => {
    expect(classifyCasualPrompt("hello, could you summarise my meeting notes from yesterday")).toBeNull();
  });
});

describe("classifyMetaPrompt — questions ABOUT Muse itself (precision-first)", () => {
  it("matches self-referential capability / identity / usage questions (EN + KO)", () => {
    for (const q of [
      "what can you do?", "what can you do", "what do you do", "what are you",
      "who are you?", "what is muse", "how do you work?", "how does this work",
      "what can I ask", "help", "넌 뭐야?", "뭐 할 수 있어", "어떻게 작동해", "사용법",
      "넌 뭐 할 수 있어?", "너 뭐 할 수 있어", "뭐 할 줄 알아?", "누구야"
    ]) {
      expect(classifyMetaPrompt(q)).toBe(true);
    }
  });

  it("NFD Korean misses the classifier (the macOS/Swift desktop bug) — NFC normalization recovers it", () => {
    // macOS/Swift passes CLI args in NFD (Hangul decomposed into jamo), so the
    // desktop companion's Korean turns missed every NFC classifier. runLocalChat
    // now NFC-normalizes the message; this documents why.
    const nfd = "뭐 할 수 있어?".normalize("NFD");
    expect(nfd).not.toBe("뭐 할 수 있어?");
    expect(classifyMetaPrompt(nfd)).toBe(false);
    expect(classifyMetaPrompt(nfd.normalize("NFC"))).toBe(true);
  });

  it("does NOT match a question about the user's notes that merely contains a meta word", () => {
    for (const q of [
      "what can you do about my taxes?",
      "how do you make sourdough",
      "what are you working on in the migration plan",
      "who are the attendees in the Q3 meeting",
      "what is my rent",
      "파이썬으로 뭐 할 수 있어?",
      "오늘 뭐 할 수 있는 시간 있어?"
    ]) {
      expect(classifyMetaPrompt(q)).toBe(false);
    }
  });
});

describe("classifyActionRequest — imperative DO-something requests (needs tools), not questions", () => {
  it("matches imperative action requests, with or without a polite lead", () => {
    for (const q of [
      "remind me to call the dentist tomorrow",
      "set a reminder for the 9am standup",
      "add a task to review the deck",
      "create an event for Friday",
      "email Sarah the notes",
      "can you remind me to water the plants",
      "please add a reminder to renew the passport",
      "I'd like you to schedule a call with Mina"
    ]) {
      expect(classifyActionRequest(q)).toBe(true);
    }
  });

  it("does NOT match a QUESTION about actions/reminders (only imperatives)", () => {
    for (const q of [
      "what reminders do I have?",
      "when is my dentist reminder?",
      "did you email Sarah?",
      "what should I remind myself about",
      "how do I set a reminder",
      "what is my rent"
    ]) {
      expect(classifyActionRequest(q)).toBe(false);
    }
  });

  it("matches a code-fix request that names an explicit FILE/PATH (a structural, homonym-free signal)", () => {
    for (const q of [
      "fix the bug in add.ts",
      "edit the function in src/math.ts",
      "update README.md",
      "change the return value in utils.js",
      "refactor packages/fs/src/runner.ts",
      "rename the variable in ./lib/helpers.py",
      "add.ts의 버그 고쳐줘",
      "src/math.ts 수정해줘"
    ]) {
      expect(classifyActionRequest(q)).toBe(true);
    }
  });

  it("does NOT over-match a non-code imperative or a code QUESTION (no explicit file ⇒ no match — kills the homonym class)", () => {
    for (const q of [
      // homonym traps from the fire-26 over-match findings — NONE names a file.
      "change my class schedule",
      "update my class notes",
      "correct the error on my invoice",
      "rename the test on my calendar",
      "fix the line at the pharmacy",
      "change the function next Friday",
      "fix the variable rate mortgage",
      "update the science class",
      "fix the parking module",
      // path-PREFIX homonyms — app/build/tests/lib are common words; without a
      // code-extension filename they must NOT match (the structural signal is a
      // `name.<code-ext>`, not a bare prefix).
      "update my app/website",
      "change my app/notification settings",
      "change my tests/quizzes for the kids",
      "fix the build/construction project",
      "correct the app/billing address",
      // questions (even with a filename) are not imperatives.
      "how do I fix add.ts",
      "what's in add.ts",
      "why is there a bug in add.ts"
    ]) {
      expect(classifyActionRequest(q)).toBe(false);
    }
  });
});

describe("answerPromisesAction — catches a false 'I'll remind you' in the ANSWER (incl. mixed requests)", () => {
  it("matches an answer that claims it set/will set a tool action", () => {
    for (const a of [
      "Your rent is 1,250,000 KRW. I will remind you to pay it tomorrow.",
      "I'll set a reminder for the standup.",
      "I've set a reminder to renew the passport.",
      "Sure — I'll add a task to review the deck.",
      "I have scheduled the lunch.",
      "I'm going to email Sarah the notes."
    ]) {
      expect(answerPromisesAction(a)).toBe(true);
    }
  });

  it("does NOT match a plain cited answer or a conversational 'I'll explain'", () => {
    for (const a of [
      "Your rent is 1,250,000 KRW [from lease.md].",
      "I'll explain how WireGuard MTU works.",
      "I'm not sure — that isn't in your notes.",
      "You have a reminder to pay rent tomorrow."
    ]) {
      expect(answerPromisesAction(a)).toBe(false);
    }
  });
});

describe("requestsToolAction — an imperative DO-something request, KO + EN", () => {
  it("matches Korean action requests (noun + verb + imperative ending)", () => {
    for (const q of [
      "내일 오후 3시 회의 일정 추가해줘",
      "이번 주 토요일 오후 2시 친구 만나는 일정 추가해줘",
      "내일 9시 약 먹으라고 알림 맞춰줘",
      "우유 사기 할 일에 추가해줘",
      "다음 주 월요일 미팅 일정 등록해 주세요",
      "치과 예약 잡아줘"
    ]) {
      expect(requestsToolAction(q)).toBe(true);
    }
  });

  it("does NOT match a Korean QUESTION about an action (no imperative ending) — a re-run would duplicate", () => {
    for (const q of [
      "방금 회의 일정 추가했어?",
      "내 리마인더 다 보여줘",
      "오늘 일정 뭐 있어?",
      "회의 일정을 추가하고 싶은데 어떻게 해?"
    ]) {
      expect(requestsToolAction(q)).toBe(false);
    }
  });

  it("still matches the English imperative path", () => {
    expect(requestsToolAction("remind me to call the dentist tomorrow")).toBe(true);
    expect(requestsToolAction("what reminders do I have?")).toBe(false);
  });
});

describe("answerClaimsAction — the answer CLAIMS a tool action was done, KO + EN", () => {
  it("matches the Korean false 'done' the desktop companion actually emits", () => {
    for (const a of [
      "진안 씨, 회의 일정이 내일 오후 3시에 추가되었습니다.",
      "친구 만나기 일정이 추가되었습니다.",
      "약 먹기 알림을 내일 오전 9시에 설정했어요.",
      "할 일에 추가했어요.",
      "리마인더 맞췄어요.",
      "치과 예약 잡아놨어요."
    ]) {
      expect(answerClaimsAction(a)).toBe(true);
    }
  });

  it("does NOT match a Korean answer that only DISCUSSES an action (no done-phrase)", () => {
    for (const a of [
      "회의 일정을 추가하고 싶으시면 말씀해 주세요.",
      "오늘 일정은 회의 하나뿐이에요.",
      "어떤 리마인더를 원하세요?"
    ]) {
      expect(answerClaimsAction(a)).toBe(false);
    }
  });

  it("still matches the English promise and stays quiet on a plain cited answer", () => {
    expect(answerClaimsAction("I've set a reminder to renew the passport.")).toBe(true);
    expect(answerClaimsAction("Your rent is 1,250,000 KRW [from lease.md].")).toBe(false);
  });

  it("does NOT treat an OFFER / permission-question as a claim (…드릴까요? is asking, not doing)", () => {
    // the real-run false positive: an offer matched `추가해\s*[드놨]` and got logged
    // as a false promise. An interrogative `…까요?` is asking, not claiming.
    for (const a of [
      "내일 오후 3시에 '팀 회의' 알림을 추가해 드릴까요?",
      "치과 예약을 잡아 드릴까요?",
      "리마인더를 설정해 드릴까요?"
    ]) {
      expect(answerClaimsAction(a), a).toBe(false);
    }
    // a declarative PROMISE (…게요) is still a claim — the guard only excludes the question form
    expect(answerClaimsAction("내일 오후 3시에 회의 일정을 추가해 드릴게요.")).toBe(true);
  });

  it("matches a COMPUTER-CONTROL code-fix completion claim (EN + KO) — the backstop's third leg", () => {
    for (const a of [
      "I fixed the bug in add.ts.",
      "I've edited the add function to return a + b.",
      "I updated README.md as requested.",
      "Done — I changed the return value.",
      // TERSE whole-answer claims (anchored, not a bare \bdone\b substring).
      "Done.",
      "Done!",
      "All done.",
      "완료했습니다.",
      "수정했습니다.",
      "add.ts의 버그를 고쳤어요.",
      "함수를 편집했어요."
    ]) {
      expect(answerClaimsAction(a), a).toBe(true);
    }
  });

  it("does NOT treat a code-fix FUTURE / OFFER / ADVICE / DESCRIPTION as a completion claim", () => {
    for (const a of [
      "I will fix the bug in add.ts.",
      "Shall I fix the bug?",
      "I can fix the add function for you.",
      "You should edit the add function to return a + b.",
      "To fix this, change the return value in add.ts.",
      "The add function returns the wrong value.",
      "버그를 고치려면 add.ts를 수정하세요.",
      "수정할까요?",
      // "done" NON-completion senses — negation / partial / idiom / question /
      // passive. A bare `\bdone\b` would wrongly flag these (JUDGE-DRILL #3); the
      // whole-answer anchor must leave them FALSE so an honest in-progress answer
      // on a code-fix turn is not re-prompted as a false done.
      "I'm not done yet.",
      "I'm almost done — still tracing the bug.",
      "This isn't done.",
      "I'm done looking, but I haven't fixed it yet.",
      "well done!",
      "are you done?",
      "the migration is done automatically by the framework"
    ]) {
      expect(answerClaimsAction(a), a).toBe(false);
    }
  });
});

describe("classifyCorpusOverview — whole-corpus overview, not a specific recall", () => {
  it("matches an overview/listing request about the whole note corpus (EN + KO)", () => {
    for (const q of [
      "what's in my notes?",
      "summarize my notes",
      "list my notes",
      "give me a one-line summary of what's in my notes",
      "what do I have notes",
      "내 노트 요약",
      "노트 목록"
    ]) {
      expect(classifyCorpusOverview(q)).toBe(true);
    }
  });

  it("does NOT match a SPECIFIC question that ends in its own topic, not 'notes'", () => {
    for (const q of [
      "what's in my notes about the VPN?",
      "summarize my VPN notes",
      "what is my rent",
      "list the attendees of the Q3 meeting",
      "what did I write about the migration plan"
    ]) {
      expect(classifyCorpusOverview(q)).toBe(false);
    }
  });
});

describe("classifyTaskListQuery — the VIEW-my-tasks intent the model fumbles, not a mutate", () => {
  it("matches a request to SEE the task list (EN + KO)", () => {
    for (const q of [
      "내 할일 뭐 있어?",
      "할 일 뭐 남았어?",
      "할일 알려줘",
      "할 일 목록 보여줘",
      "what tasks do I have?",
      "list my tasks",
      "show me my to-dos"
    ]) {
      expect(classifyTaskListQuery(q)).toBe(true);
    }
  });

  it("does NOT match an ADD / complete / move intent (those need the real tool)", () => {
    for (const q of [
      "우유 사기 할일 추가해줘",
      "보고서 제출 할일 완료로 표시해줘",
      "그 할일 삭제해줘",
      "할일을 오후 6시로 바꿔줘",
      "add buy milk to my tasks",
      "mark the report task done"
    ]) {
      expect(classifyTaskListQuery(q)).toBe(false);
    }
  });

  it("does NOT hijack a calendar or note overview (those route elsewhere)", () => {
    for (const q of ["내 일정 뭐 있어?", "이번 주 일정 보여줘", "내 노트 뭐 있어?"]) {
      expect(classifyTaskListQuery(q)).toBe(false);
    }
  });
});

describe("classifyReminderListQuery — the VIEW-my-reminders intent the model fumbles, not a mutate", () => {
  it("matches a request to SEE the reminder list (EN + KO)", () => {
    for (const q of ["리마인더 뭐 있어?", "내 알림 목록 보여줘", "리마인더 알려줘", "what reminders do I have?", "list my reminders", "show me my reminders"]) {
      expect(classifyReminderListQuery(q)).toBe(true);
    }
  });

  it("does NOT match a set / snooze / clear intent (those need the real tool)", () => {
    for (const q of ["약 먹기 리마인더 추가해줘", "운동 리마인더 설정해줘", "그 리마인더 삭제해줘", "리마인더 30분 미뤄줘", "set a reminder for 5pm", "clear the dentist reminder"]) {
      expect(classifyReminderListQuery(q)).toBe(false);
    }
  });

  it("does NOT hijack a task or calendar overview", () => {
    for (const q of ["내 할일 뭐 있어?", "내 일정 뭐 있어?"]) {
      expect(classifyReminderListQuery(q)).toBe(false);
    }
  });
});

describe("classifyContactLookup — extract the contact name from a details lookup (the 8B abstains)", () => {
  it("returns the name token for a detail lookup (KO + EN)", () => {
    expect(classifyContactLookup("박지훈 전화번호 알려줘")).toBe("박지훈");
    expect(classifyContactLookup("박지훈 연락처 뭐야")).toBe("박지훈");
    expect(classifyContactLookup("박지훈은 나랑 무슨 관계야?")).toBe("박지훈");
    expect(classifyContactLookup("박지훈 생일 언제야")).toBe("박지훈");
    expect(classifyContactLookup("Sarah's email")).toBe("Sarah");
  });

  it("returns null for an outbound ACTION or a non-contact phrase (resolveContact never gets a bad ref)", () => {
    for (const q of ["박지훈한테 전화해줘", "박지훈한테 이메일 보내줘", "이 식당 전화번호", "내 전화번호 뭐야", "오늘 날씨 어때", "안녕"]) {
      expect(classifyContactLookup(q)).toBeNull();
    }
  });
});
