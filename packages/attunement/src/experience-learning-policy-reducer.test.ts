import { describe, expect, it } from "vitest";

import { reduceExperienceLearningContinuityPolicy, type ContinuityPolicy } from "./index.js";

const CURRENT: ContinuityPolicy = Object.freeze({
  detail: "standard",
  nextStep: "direct",
  suppression: "none",
  version: 4
});

describe("reduceExperienceLearningContinuityPolicy", () => {
  it("changes only reviewed display fields and advances the supplied version", () => {
    expect(reduceExperienceLearningContinuityPolicy(CURRENT, {
      detail: "compact",
      kind: "thread-display",
      nextStep: "contextual"
    }, 8)).toEqual({
      detail: "compact",
      nextStep: "contextual",
      suppression: "none",
      version: 8
    });
    expect(CURRENT).toEqual({
      detail: "standard",
      nextStep: "direct",
      suppression: "none",
      version: 4
    });
  });

  it("changes only suppression", () => {
    expect(reduceExperienceLearningContinuityPolicy(CURRENT, {
      kind: "thread-suppression",
      suppression: "acknowledge-previous"
    }, 5)).toEqual({
      detail: "standard",
      nextStep: "direct",
      suppression: "acknowledge-previous",
      version: 5
    });
  });

  it("rejects timing changes and stale or unsafe versions", () => {
    expect(reduceExperienceLearningContinuityPolicy(CURRENT, {
      adjustment: "increase-cooldown",
      kind: "thread-timing"
    }, 5)).toBeUndefined();
    expect(reduceExperienceLearningContinuityPolicy(CURRENT, {
      kind: "thread-suppression",
      suppression: "none"
    }, 4)).toBeUndefined();
    expect(reduceExperienceLearningContinuityPolicy(CURRENT, {
      kind: "thread-suppression",
      suppression: "none"
    }, Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
  });
});
