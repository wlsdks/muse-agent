import { describe, expect, it } from "vitest";

import { answerIsRefusal, shouldWarmClose } from "./commands-ask.js";

describe("shouldWarmClose — warm refusal close only on a refusal with notes present", () => {
  it("fires on a refusal when the user HAS notes", () => {
    expect(shouldWarmClose("I don't have anything in your notes on that.", 5)).toBe(true);
    expect(shouldWarmClose("저는 그 정보를 가지고 있지 않습니다.", 3)).toBe(true);
  });

  it("does NOT fire on an empty corpus (the on-ramp hint covers that) or on a real answer", () => {
    expect(shouldWarmClose("I don't have that.", 0)).toBe(false); // empty corpus → on-ramp instead
    expect(shouldWarmClose("The MTU is 1380 [from vpn.md].", 5)).toBe(false); // real cited answer
  });
});

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
