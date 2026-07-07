import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCelebration, createPetController } from "./desk-pet-controller.js";

import type { PetInputs } from "./desk-pet-controller.js";
import type { PetState } from "./desk-pet-machine.js";

const BOUNDS = { min: 0, max: 100 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function makeController(initial: PetInputs = { inFlight: false, bounds: BOUNDS }) {
  const inputs = { ...initial };
  const frames: PetState[] = [];
  const controller = createPetController({
    getInputs: () => inputs,
    onFrame: (s) => frames.push(s),
    rand: () => 0.1,
    frameMs: 150
  });
  return { controller, frames, setInputs: (patch: Partial<PetInputs>) => Object.assign(inputs, patch) };
}

describe("createPetController", () => {
  it("start schedules ticks; each frame interval advances the pet", () => {
    const { controller, frames } = makeController();
    controller.start();
    expect(controller.isRunning()).toBe(true);
    expect(frames).toHaveLength(0);

    vi.advanceTimersByTime(150 * 3);
    expect(frames).toHaveLength(3);
    controller.stop();
  });

  it("stop clears the timer — no further frames are produced", () => {
    const { controller, frames } = makeController();
    controller.start();
    vi.advanceTimersByTime(150 * 2);
    const countAtStop = frames.length;

    controller.stop();
    expect(controller.isRunning()).toBe(false);

    vi.advanceTimersByTime(150 * 10);
    expect(frames).toHaveLength(countAtStop); // nothing after stop
  });

  it("an in-flight input flips the pet to attentive", () => {
    const { controller, frames, setInputs } = makeController();
    controller.start();
    setInputs({ inFlight: true });
    vi.advanceTimersByTime(150);
    expect(frames.at(-1)?.activity).toBe("attentive");
    controller.stop();
  });

  it("derives the completed edge (in-flight → done) and fires the chirp", () => {
    const { controller, frames, setInputs } = makeController();
    controller.start();
    setInputs({ inFlight: true });
    vi.advanceTimersByTime(150); // now attentive, prevInFlight = true
    setInputs({ inFlight: false });
    vi.advanceTimersByTime(150); // completed edge → chirp
    expect(frames.at(-1)?.chirp).toBeGreaterThan(0);
    controller.stop();
  });

  it("a new error value fires the fluster reaction", () => {
    const { controller, frames, setInputs } = makeController();
    controller.start();
    vi.advanceTimersByTime(150); // a normal frame, no error
    setInputs({ error: "network down" });
    vi.advanceTimersByTime(150); // errored edge → fluster
    expect(frames.at(-1)?.activity).toBe("fluster");
    controller.stop();
  });

  it("the same error value fires the fluster only once (edge, not level)", () => {
    const { controller, frames, setInputs } = makeController();
    controller.start();
    setInputs({ error: "boom" });
    vi.advanceTimersByTime(150); // fluster
    expect(frames.at(-1)?.activity).toBe("fluster");
    vi.advanceTimersByTime(150 * 8); // same error stays set; no re-fluster
    // The fluster runs its shiver→droop→idle course and lands back on idle.
    expect(frames.at(-1)?.activity).toBe("idle");
    controller.stop();
  });

  it("reduced motion emits a single static frame and schedules no interval", () => {
    const inputs = { inFlight: false, bounds: BOUNDS };
    const frames: PetState[] = [];
    const controller = createPetController({
      getInputs: () => inputs,
      onFrame: (s) => frames.push(s),
      reducedMotion: true,
      frameMs: 150
    });
    controller.start();
    expect(controller.isRunning()).toBe(false);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.phase).toBe("stand");

    vi.advanceTimersByTime(150 * 20);
    expect(frames).toHaveLength(1); // still static, no ticks
    controller.stop();
  });
});

describe("createCelebration", () => {
  it("shows the heart immediately, then auto-decays after the hold", () => {
    const seen: boolean[] = [];
    const heart = createCelebration((v) => seen.push(v), 1000);
    heart.fire();
    expect(seen.at(-1)).toBe(true);
    vi.advanceTimersByTime(999);
    expect(seen.at(-1)).toBe(true); // still holding
    vi.advanceTimersByTime(1);
    expect(seen.at(-1)).toBe(false); // decayed
  });

  it("re-firing restarts the hold rather than double-scheduling", () => {
    const seen: boolean[] = [];
    const heart = createCelebration((v) => seen.push(v), 1000);
    heart.fire();
    vi.advanceTimersByTime(600);
    heart.fire(); // restart
    vi.advanceTimersByTime(600); // 1200 total from first, but only 600 since restart
    expect(seen.at(-1)).toBe(true);
    vi.advanceTimersByTime(400);
    expect(seen.at(-1)).toBe(false);
  });

  it("cancel hides immediately and drops the pending decay", () => {
    const seen: boolean[] = [];
    const heart = createCelebration((v) => seen.push(v), 1000);
    heart.fire();
    heart.cancel();
    expect(seen.at(-1)).toBe(false);
    const countAfterCancel = seen.length;
    vi.advanceTimersByTime(2000);
    expect(seen.length).toBe(countAfterCancel); // no further callbacks
  });
});
