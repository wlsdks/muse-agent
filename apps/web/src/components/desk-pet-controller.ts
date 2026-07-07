/**
 * Drives the pure pet machine on a fixed interval and derives the
 * one-shot `completed` edge (in-flight -> done) from successive input
 * reads. Built on setInterval (not rAF) so it is fully controllable
 * under fake timers in a Node test, and so unmount cleanup is a single
 * clearInterval.
 */

import { advancePet, FRAME_MS, initialPetState, staticPetState } from "./desk-pet-machine.js";

import type { Bounds, PetState } from "./desk-pet-machine.js";

export interface PetInputs {
  readonly inFlight: boolean;
  readonly bounds: Bounds;
  /** the current chat error, if any — a new value fires the error fluster. */
  readonly error?: string | null;
}

export interface PetControllerOptions {
  readonly getInputs: () => PetInputs;
  readonly onFrame: (state: PetState) => void;
  readonly reducedMotion?: boolean;
  readonly rand?: () => number;
  readonly frameMs?: number;
}

export interface PetController {
  start: () => void;
  stop: () => void;
  getState: () => PetState;
  isRunning: () => boolean;
}

export function createPetController(options: PetControllerOptions): PetController {
  const rand = options.rand ?? Math.random;
  const frameMs = options.frameMs ?? FRAME_MS;
  let state: PetState = options.reducedMotion ? staticPetState() : initialPetState();
  let prevInFlight = false;
  let prevError: string | null = null;
  let handle: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    const { inFlight, bounds, error } = options.getInputs();
    const completed = prevInFlight && !inFlight;
    const nextError = error ?? null;
    const errored = nextError !== null && nextError !== prevError;
    prevInFlight = inFlight;
    prevError = nextError;
    state = advancePet(state, { inFlight, completed, errored, bounds, rand });
    options.onFrame(state);
  };

  return {
    start() {
      if (options.reducedMotion) {
        // Static pose, no interval — respects prefers-reduced-motion.
        options.onFrame(state);
        return;
      }
      if (handle !== null) {
        return;
      }
      handle = setInterval(tick, frameMs);
    },
    stop() {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
    },
    getState() {
      return state;
    },
    isRunning() {
      return handle !== null;
    }
  };
}

export interface Celebration {
  /** Show the heart pop; auto-decays after the hold. Re-firing restarts it. */
  fire: () => void;
  /** Hide immediately and drop any pending decay (unmount cleanup). */
  cancel: () => void;
}

/**
 * The reserved `celebrate()` flourish: a heart pops above the bird and decays
 * on its own after `holdMs`. Kept as a tiny pure timer helper (not baked into
 * the pet machine) so future praise-detection can trigger it on demand, and so
 * its show → decay is unit-testable under fake timers without a DOM.
 */
export function createCelebration(onChange: (visible: boolean) => void, holdMs = 1200): Celebration {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  };
  return {
    fire() {
      onChange(true);
      clear();
      handle = setTimeout(() => {
        handle = null;
        onChange(false);
      }, holdMs);
    },
    cancel() {
      clear();
      onChange(false);
    }
  };
}
