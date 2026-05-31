import { describe, expect, it } from "vitest";

import { answerIsRefusal } from "./commands-ask.js";

describe("answerIsRefusal — a refusal must not carry a citation (EN + KO)", () => {
  it("detects clear English refusals", () => {
    expect(answerIsRefusal("I don't have access to your sister's birthday.")).toBe(true);
    expect(answerIsRefusal("None of the provided context contains that information.")).toBe(true);
    expect(answerIsRefusal("I'm not sure — nothing in your notes covers that.")).toBe(true);
    expect(answerIsRefusal("I couldn't find anything about your car purchase.")).toBe(true);
  });

  it("detects clear Korean refusals (the case the English-only sweep missed)", () => {
    // the live failure: a KO refusal that wrongly appended `cite as: [from preferences.md]`
    expect(answerIsRefusal("저는 그런 개인적인 정보를 저장하고 있지 않습니다.")).toBe(true);
    expect(answerIsRefusal("죄송하지만 그 정보는 없습니다.")).toBe(true);
    expect(answerIsRefusal("관련 정보를 찾을 수 없습니다.")).toBe(true);
  });

  it("does NOT fire on a real cited answer — citations are preserved", () => {
    expect(answerIsRefusal("You set the MTU to 1380 for the WireGuard VPN [from vpn.md].")).toBe(false);
    expect(answerIsRefusal("Rent is due on the 25th, $1,450 [from tasks/finances.md].")).toBe(false);
    expect(answerIsRefusal("WireGuard VPN의 MTU는 1380으로 설정했습니다 [from vpn.md].")).toBe(false);
  });
});
