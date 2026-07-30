import { describe, expect, it } from "vitest";

import { createLatestAdaptationLoopHealthObserver } from "../src/adaptation-loop-health-observer.js";
import { experienceLearningPromotionReceipt } from "./helpers/experience-learning-promotion-receipt.js";

describe("latest adaptation loop health observer", () => {
  it("accepts only verified receipts and keeps the newest immutable projection", () => {
    const observer = createLatestAdaptationLoopHealthObserver();
    const older = experienceLearningPromotionReceipt("2026-07-30T00:02:00Z", "older");
    const newer = experienceLearningPromotionReceipt("2026-07-30T00:02:00.500Z", "newer");

    expect(observer.snapshot()).toBeUndefined();
    observer.observe({ ...newer, promotionId: "forged" });
    expect(observer.snapshot()).toBeUndefined();

    observer.observe(newer);
    observer.observe(older);

    expect(observer.snapshot()).toEqual({
      evidenceId: newer.promotionId,
      evidenceVerified: true,
      status: "promoted"
    });
    expect(Object.isFrozen(observer.snapshot())).toBe(true);
  });

  it("settles equal timestamps independently of callback arrival order", () => {
    const firstReceipt = experienceLearningPromotionReceipt("2026-07-30T00:02:00.000Z", "a");
    const secondReceipt = experienceLearningPromotionReceipt("2026-07-30T00:02:00.000Z", "b");
    const first = createLatestAdaptationLoopHealthObserver();
    const second = createLatestAdaptationLoopHealthObserver();

    first.observe(firstReceipt);
    first.observe(secondReceipt);
    second.observe(secondReceipt);
    second.observe(firstReceipt);

    expect(first.snapshot()).toEqual(second.snapshot());
  });
});
