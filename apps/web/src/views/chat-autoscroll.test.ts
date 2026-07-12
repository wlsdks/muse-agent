import { describe, expect, it } from "vitest";

import { shouldStickToBottom } from "./chat-autoscroll.js";

import type { ScrollMetrics } from "./chat-autoscroll.js";

const CONTENT_HEIGHT = 1000;
const VIEWPORT_HEIGHT = 500;
const MAX_SCROLL_TOP = CONTENT_HEIGHT - VIEWPORT_HEIGHT;

/** Builds metrics for a given distance-from-bottom (in px), holding content
 * and viewport height fixed so each case only varies `scrollTop`. */
function atDistance(distanceFromBottom: number): ScrollMetrics {
  return {
    scrollTop: MAX_SCROLL_TOP - distanceFromBottom,
    scrollHeight: CONTENT_HEIGHT,
    clientHeight: VIEWPORT_HEIGHT
  };
}

describe("shouldStickToBottom — smart-tail auto-scroll gate", () => {
  it("sticks when the viewport is exactly at the bottom (distance 0)", () => {
    expect(shouldStickToBottom(atDistance(0))).toBe(true);
  });

  it("sticks when near the bottom, inside the default threshold (distance 40 < 80)", () => {
    expect(shouldStickToBottom(atDistance(40))).toBe(true);
  });

  it("does NOT stick once the user has scrolled up past the threshold (distance 300 > 80)", () => {
    expect(shouldStickToBottom(atDistance(300))).toBe(false);
  });

  it("sticks exactly AT the default threshold boundary (distance === 80)", () => {
    expect(shouldStickToBottom(atDistance(80))).toBe(true);
  });

  it("sticks on overscroll — scrollTop past the max scrollable position (negative distance)", () => {
    expect(shouldStickToBottom(atDistance(-50))).toBe(true);
  });

  it("honors a custom threshold: distance just inside it sticks", () => {
    expect(shouldStickToBottom(atDistance(150), 200)).toBe(true);
  });

  it("honors a custom threshold: distance just outside it does not stick", () => {
    expect(shouldStickToBottom(atDistance(250), 200)).toBe(false);
  });
});
