import { describe, expect, it } from "vitest";

import { guardAgainstUnbackedActionClaim, unbackedActionNoticeFor } from "../src/honest-action-guard.js";

const KO_QUERY = "내일 오후 3시에 치과 예약 잡아줘";
const EN_QUERY = "book me a dentist appointment tomorrow at 3pm";
const res = (output: string, toolsUsed: readonly string[] = []) => ({ response: { output }, toolsUsed });

describe("guardAgainstUnbackedActionClaim — the API/channel honest-action gate", () => {
  it("downgrades a KO unbacked completion claim to the honest KO notice (no retry provided)", async () => {
    const out = await guardAgainstUnbackedActionClaim({
      firstResult: res("내일 오후 3시에 '치과 예약'을 등록했습니다.", []),
      query: KO_QUERY
    });
    expect(out.response.output).toBe(unbackedActionNoticeFor(KO_QUERY));
    expect(out.response.output).not.toContain("등록했습니다");
  });

  it("downgrades an EN unbacked completion claim to the honest EN notice", async () => {
    const out = await guardAgainstUnbackedActionClaim({
      firstResult: res("I've booked your dentist appointment for tomorrow at 3pm.", []),
      query: EN_QUERY
    });
    expect(out.response.output).toBe(unbackedActionNoticeFor(EN_QUERY));
  });

  it("leaves the answer UNTOUCHED when a real actuator tool ran", async () => {
    const backed = res("Booked your dentist appointment for tomorrow at 3pm.", ["calendar.create"]);
    const out = await guardAgainstUnbackedActionClaim({ firstResult: backed, query: EN_QUERY });
    expect(out).toBe(backed);
  });

  it("leaves the answer UNTOUCHED when the query never requested an action (a plain question)", async () => {
    const answer = res("Your next dentist visit is on file for the 14th.", []);
    const out = await guardAgainstUnbackedActionClaim({ firstResult: answer, query: "언제가 치과 예약이야?" });
    expect(out).toBe(answer);
  });

  it("leaves the answer UNTOUCHED when the answer makes no completion claim", async () => {
    const answer = res("I can't book appointments — try the clinic's own booking page.", []);
    const out = await guardAgainstUnbackedActionClaim({ firstResult: answer, query: KO_QUERY });
    expect(out).toBe(answer);
  });

  it("retries once via the shared clean-history re-prompt, and keeps the retry when it actually acted", async () => {
    let retries = 0;
    const out = await guardAgainstUnbackedActionClaim({
      firstResult: res("내일 오후 3시에 '치과 예약'을 등록했습니다.", []),
      query: KO_QUERY,
      retry: async () => {
        retries += 1;
        return res("네, 등록했습니다.", ["calendar.create"]);
      }
    });
    expect(retries).toBe(1);
    expect(out.response.output).toBe("네, 등록했습니다.");
    expect(out.toolsUsed).toEqual(["calendar.create"]);
  });

  it("downgrades to the honest notice when the retry ALSO fails to act", async () => {
    let retries = 0;
    const out = await guardAgainstUnbackedActionClaim({
      firstResult: res("내일 오후 3시에 '치과 예약'을 등록했습니다.", []),
      query: KO_QUERY,
      retry: async () => {
        retries += 1;
        return res("네, 등록했습니다.", []);
      }
    });
    expect(retries).toBe(1);
    expect(out.response.output).toBe(unbackedActionNoticeFor(KO_QUERY));
  });
});

describe("unbackedActionNoticeFor", () => {
  it("picks the Korean notice for a Korean query", () => {
    expect(unbackedActionNoticeFor(KO_QUERY)).toMatch(/[가-힣]/u);
  });

  it("picks the English notice for an English query", () => {
    expect(unbackedActionNoticeFor(EN_QUERY)).not.toMatch(/[가-힣]/u);
  });
});
