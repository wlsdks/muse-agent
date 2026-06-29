import type { KnowledgeMatch } from "@muse/agent-core";
import { isAbstentionSentence, reportCitationRecall } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

const m = (text: string, source: string): KnowledgeMatch => ({ score: 0.8, source, text, trusted: true } as KnowledgeMatch);

describe("citation-recall: abstention sentences are NOT flagged as missing-citation claims", () => {
  // A broad evidence union (the user's note + unrelated tasks/reminders) inflates token
  // overlap so an honest "I don't have that" looks 'citable' — the bug a real ask probe found.
  const broad = [
    m("I have a dentist appointment next week at the Smile Dental clinic.", "dentist.md"),
    m("Open task: confirm the appointment time for the team sync", "task:1"),
    m("Reminder: call the clinic about the specific appointment", "reminder:2")
  ];
  it("an abstention ('I do not have a specific time…') is excluded from the citable set (no false warning)", () => {
    const ans = "I'm afraid I do not have a specific time listed for your appointment, sir. I can only confirm that you have an appointment at the Smile Dental clinic next week [from dentist.md].";
    expect(reportCitationRecall(ans, broad).uncited).toEqual([]);
  });
  it("REGRESSION GUARD: a genuine UNcited claim is still flagged (the fix doesn't hide real misses)", () => {
    const ans = "You have a dentist appointment at the Smile Dental clinic next week.";
    expect(reportCitationRecall(ans, broad).uncited).toEqual(["You have a dentist appointment at the Smile Dental clinic next week."]);
  });
});

describe("isAbstentionSentence", () => {
  it.each([
    "I don't have that information",
    "I do not have a specific time listed for your appointment",
    "I'm not sure about that",
    "I cannot find any record of it",
    "There is no phone number recorded",
    "That is not in your notes",
    "기록에 없습니다",
    "확실하지 않습니다"
  ])("abstention: %s", (s) => expect(isAbstentionSentence(s)).toBe(true));
  it.each([
    "You have an appointment at 3pm",
    "I can only confirm you have an appointment at Smile Dental",
    "The meeting is scheduled for Tuesday"
  ])("NOT an abstention (a real claim): %s", (s) => expect(isAbstentionSentence(s)).toBe(false));
});
