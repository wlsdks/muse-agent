/**
 * The desk-pet behaviour as a pure, step-based state machine. One
 * `advancePet` call = one animation tick (FRAME_MS apart). Keeping it
 * pure (all randomness + time injected) makes the whole behaviour loop
 * deterministically unit-testable without a DOM or fake timers.
 *
 * The React component owns the interval and re-renders on each new state;
 * this module owns ONLY the decision of "what does the bird do next".
 */

import type { FrameName } from "./pixel-bird.js";

export const FRAME_MS = 150;

const HOP_TICKS = 1; // each hop half lasts one tick (~300ms per hop)
const CHIRP_TICKS = 8; // chirp accents linger ~1.2s after a response lands
const WANDER_PROB = 0.5; // chance an idle pause ends in a wander burst
const HOP_STEP = 4; // px moved per landed hop
const ATTEND_SHIFT = 2; // px nudge while attentive

// A long stretch with no chat interaction settles the bird into a doze.
const DOZE_MIN_TICKS = 300; // ~45s at 150ms/tick
const DOZE_JITTER = 300; // + up to ~45s → randomized 45–90s
const STARTLE_TICKS = 1; // a woken bird gives a one-tick startle hop
const FLAP_HALFBEATS = 4; // flap = 4 alternating wing frames (two flutters)
const SHAKE_STEPS = 3; // ruffle = a 3-frame L-R-L wobble
const DROOP_TICKS = 3; // the brief dejected settle after an error shiver

export type Activity = "idle" | "wander" | "attentive" | "doze" | "fluster";

export interface PetState {
  readonly activity: Activity;
  readonly phase: FrameName;
  readonly facing: 1 | -1;
  readonly x: number;
  readonly ticks: number;
  readonly hopsLeft: number;
  readonly chirp: number;
  /** ticks since the last chat interaction — drives the doze timer. */
  readonly sinceInteract?: number;
  /** randomized doze threshold; re-rolled on every interaction. */
  readonly dozeAfter?: number;
}

export interface Bounds {
  readonly min: number;
  readonly max: number;
}

export interface AdvanceCtx {
  /** true while a chat request is in flight. */
  readonly inFlight: boolean;
  /** one-shot: a request just transitioned in-flight -> done. */
  readonly completed: boolean;
  /** one-shot: a chat request just failed. */
  readonly errored?: boolean;
  readonly bounds: Bounds;
  /** injected RNG in [0, 1). */
  readonly rand: () => number;
}

function rollDozeAfter(rand: () => number): number {
  return DOZE_MIN_TICKS + Math.floor(rand() * DOZE_JITTER);
}

export function initialPetState(x = 0): PetState {
  return {
    activity: "idle",
    phase: "stand",
    facing: 1,
    x,
    ticks: 6,
    hopsLeft: 0,
    chirp: 0,
    sinceInteract: 0,
    dozeAfter: DOZE_MIN_TICKS + Math.floor(DOZE_JITTER / 2)
  };
}

/** The single static pose used under prefers-reduced-motion. */
export function staticPetState(x = 0): PetState {
  return {
    activity: "idle",
    phase: "stand",
    facing: 1,
    x,
    ticks: Infinity,
    hopsLeft: 0,
    chirp: 0,
    sinceInteract: 0,
    dozeAfter: Infinity
  };
}

function clamp(x: number, b: Bounds): number {
  return Math.max(b.min, Math.min(b.max, x));
}

const IDLE_VARIATIONS: readonly { phase: FrameName; ticks: number; weight: number }[] = [
  { phase: "blink", ticks: 2, weight: 5 },
  { phase: "tilt", ticks: 4, weight: 4 },
  { phase: "peck", ticks: 4, weight: 4 },
  { phase: "preen", ticks: 6, weight: 2 },
  { phase: "tail", ticks: 3, weight: 2 },
  { phase: "flapA", ticks: 1, weight: 1 },
  { phase: "stretch", ticks: 5, weight: 1 },
  { phase: "ruffleA", ticks: 1, weight: 1 },
  { phase: "sing", ticks: 12, weight: 0.5 }
];

const IDLE_WEIGHT_TOTAL = IDLE_VARIATIONS.reduce((sum, v) => sum + v.weight, 0);

/** The two-frame variations alternate through these paired poses. */
const ALT_FRAME: Partial<Record<FrameName, FrameName>> = {
  flapA: "flapB",
  flapB: "flapA",
  ruffleA: "ruffleB",
  ruffleB: "ruffleA"
};

function isAlternating(phase: FrameName): boolean {
  return phase in ALT_FRAME;
}

function pickIdleVariation(r: number): { phase: FrameName; ticks: number } {
  let target = r * IDLE_WEIGHT_TOTAL;
  for (const v of IDLE_VARIATIONS) {
    if (target < v.weight) {
      return v;
    }
    target -= v.weight;
  }
  return IDLE_VARIATIONS[0]!;
}

/** hopsLeft seeds the alternation counter for the two-frame variations. */
function seedSteps(phase: FrameName): number {
  if (phase === "flapA") {
    return FLAP_HALFBEATS;
  }
  if (phase === "ruffleA") {
    return SHAKE_STEPS;
  }
  return 0;
}

function standPause(rand: () => number): number {
  return 4 + Math.floor(rand() * 8); // ~0.6s–1.8s
}

/**
 * Compute the next pet state. Ordering of concerns:
 *  1. a just-completed request wins → happy hop + chirp
 *  2. a just-failed request → a fluster (shiver + brief droop)
 *  3. an in-flight request forces the attentive mode (startle-hop if dozing)
 *  4. otherwise step the current idle/wander/doze/fluster behaviour
 */
export function advancePet(state: PetState, ctx: AdvanceCtx): PetState {
  const { bounds, rand } = ctx;
  const chirp = Math.max(0, state.chirp - 1);
  const sinceInteract = state.sinceInteract ?? 0;
  const dozeAfter = state.dozeAfter ?? DOZE_MIN_TICKS + Math.floor(DOZE_JITTER / 2);

  if (ctx.completed) {
    return {
      activity: "wander",
      phase: "hopUp",
      facing: state.facing,
      x: state.x,
      ticks: HOP_TICKS,
      hopsLeft: 2,
      chirp: CHIRP_TICKS,
      sinceInteract: 0,
      dozeAfter: rollDozeAfter(rand)
    };
  }

  if (ctx.errored) {
    return {
      activity: "fluster",
      phase: "ruffleA",
      facing: state.facing,
      x: state.x,
      ticks: 1,
      hopsLeft: SHAKE_STEPS,
      chirp,
      sinceInteract: 0,
      dozeAfter: rollDozeAfter(rand)
    };
  }

  if (ctx.inFlight) {
    if (state.activity === "doze") {
      // Woken by a new request — a small startle hop, then attentive.
      return {
        activity: "attentive",
        phase: "hopUp",
        facing: state.facing,
        x: state.x,
        ticks: STARTLE_TICKS,
        hopsLeft: 0,
        chirp,
        sinceInteract: 0,
        dozeAfter: rollDozeAfter(rand)
      };
    }
    if (state.activity !== "attentive") {
      return { activity: "attentive", phase: "attend", facing: state.facing, x: state.x, ticks: 6, hopsLeft: 0, chirp, sinceInteract: 0, dozeAfter };
    }
    const ticks = state.ticks - 1;
    if (ticks > 0) {
      return { ...state, chirp, ticks, sinceInteract: 0 };
    }
    const r = rand();
    if (r < 0.4) {
      return { ...state, chirp, phase: "tilt", ticks: 4, sinceInteract: 0 };
    }
    if (r < 0.6) {
      const nx = clamp(state.x + (rand() < 0.5 ? -1 : 1) * ATTEND_SHIFT, bounds);
      return { ...state, chirp, phase: "attend", x: nx, ticks: 6, sinceInteract: 0 };
    }
    return { ...state, chirp, phase: "attend", ticks: 6, sinceInteract: 0 };
  }

  // The error fluster: shiver through the ruffle frames, then a brief droop.
  if (state.activity === "fluster") {
    const ticks = state.ticks - 1;
    if (ticks > 0) {
      return { ...state, chirp, ticks, sinceInteract };
    }
    if (state.phase === "ruffleA" || state.phase === "ruffleB") {
      if (state.hopsLeft > 0) {
        return { ...state, chirp, phase: ALT_FRAME[state.phase]!, ticks: 1, hopsLeft: state.hopsLeft - 1, sinceInteract };
      }
      return { ...state, chirp, phase: "droop", ticks: DROOP_TICKS, hopsLeft: 0, sinceInteract };
    }
    return { activity: "idle", phase: "stand", facing: state.facing, x: state.x, ticks: standPause(rand), hopsLeft: 0, chirp, sinceInteract, dozeAfter };
  }

  // Not in flight. If we were locked in attentive, relax back to idle.
  if (state.activity === "attentive") {
    return { activity: "idle", phase: "stand", facing: state.facing, x: state.x, ticks: standPause(rand), hopsLeft: 0, chirp, sinceInteract, dozeAfter };
  }

  // Dozing: stay asleep until an interaction edge (handled above) wakes it.
  if (state.activity === "doze") {
    return { ...state, chirp, sinceInteract: sinceInteract + 1 };
  }

  const nextSince = sinceInteract + 1;
  const ticks = state.ticks - 1;

  if (state.activity === "wander") {
    if (ticks > 0) {
      return { ...state, chirp, ticks, sinceInteract: nextSince };
    }
    if (state.phase === "hopUp") {
      const nx = clamp(state.x + state.facing * HOP_STEP, bounds);
      let facing = state.facing;
      if (nx <= bounds.min || nx >= bounds.max) {
        facing = (facing * -1) as 1 | -1;
      }
      const hopsLeft = state.hopsLeft - 1;
      if (hopsLeft <= 0) {
        return { activity: "idle", phase: "stand", facing, x: nx, ticks: standPause(rand), hopsLeft: 0, chirp, sinceInteract: nextSince, dozeAfter };
      }
      return { activity: "wander", phase: "hopLand", facing, x: nx, ticks: HOP_TICKS, hopsLeft, chirp, sinceInteract: nextSince, dozeAfter };
    }
    // hopLand (or the initial hop) → lift into the next hop
    return { activity: "wander", phase: "hopUp", facing: state.facing, x: state.x, ticks: HOP_TICKS, hopsLeft: state.hopsLeft, chirp, sinceInteract: nextSince, dozeAfter };
  }

  // idle
  if (ticks > 0) {
    return { ...state, chirp, ticks, sinceInteract: nextSince };
  }
  // a two-frame variation (flap / shake) mid-sequence → flip to its other frame
  if (isAlternating(state.phase) && state.hopsLeft > 0) {
    return { ...state, chirp, phase: ALT_FRAME[state.phase]!, ticks: 1, hopsLeft: state.hopsLeft - 1, sinceInteract: nextSince };
  }
  if (state.phase !== "stand") {
    // a variation just finished → brief stand pause before the next decision
    return { activity: "idle", phase: "stand", facing: state.facing, x: state.x, ticks: 3 + Math.floor(rand() * 4), hopsLeft: 0, chirp, sinceInteract: nextSince, dozeAfter };
  }
  // stand pause finished → doze (if long-idle), else wander burst or a variation
  if (nextSince >= dozeAfter) {
    return { activity: "doze", phase: "doze", facing: state.facing, x: state.x, ticks: 1, hopsLeft: 0, chirp, sinceInteract: nextSince, dozeAfter };
  }
  if (rand() < WANDER_PROB) {
    const hops = 2 + Math.floor(rand() * 3); // 2..4
    return { activity: "wander", phase: "hopUp", facing: state.facing, x: state.x, ticks: HOP_TICKS, hopsLeft: hops, chirp, sinceInteract: nextSince, dozeAfter };
  }
  const v = pickIdleVariation(rand());
  return { activity: "idle", phase: v.phase, facing: state.facing, x: state.x, ticks: v.ticks, hopsLeft: seedSteps(v.phase), chirp, sinceInteract: nextSince, dozeAfter };
}
