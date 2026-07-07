import { describe, expect, it } from "vitest";

import { advancePet, initialPetState, staticPetState } from "./desk-pet-machine.js";

import type { AdvanceCtx, PetState } from "./desk-pet-machine.js";

const BOUNDS = { min: 0, max: 100 };

function ctx(over: Partial<AdvanceCtx> = {}): AdvanceCtx {
  return { inFlight: false, completed: false, bounds: BOUNDS, rand: () => 0.1, ...over };
}

/** Run advancePet n times, threading the state, with a fixed context. */
function run(state: PetState, n: number, c: AdvanceCtx): PetState {
  let s = state;
  for (let i = 0; i < n; i++) {
    s = advancePet(s, c);
  }
  return s;
}

describe("advancePet — idle → wander", () => {
  it("an idle stand pause that expires with rand < WANDER_PROB starts a hop-wander burst", () => {
    // initial ticks = 6; the 6th advance reaches the decision with rand 0.1 (< 0.5).
    const s = run(initialPetState(), 6, ctx({ rand: () => 0.1 }));
    expect(s.activity).toBe("wander");
    expect(s.phase).toBe("hopUp");
    expect(s.hopsLeft).toBe(2); // 2 + floor(0.1*3)
  });

  it("an idle stand pause that expires with rand >= WANDER_PROB picks an idle variation instead", () => {
    const s = run(initialPetState(), 6, ctx({ rand: () => 0.9 }));
    expect(s.activity).toBe("idle");
    // The idle pool now spans the full mascot motion library.
    expect(["blink", "tilt", "peck", "preen", "tail", "flapA", "stretch", "ruffleA", "sing"]).toContain(s.phase);
  });

  it("the idle pool can select the new occasional poses (flap flutters via two frames)", () => {
    // rand call 1 (>= WANDER_PROB) skips the wander branch; call 2 (0.85) maps
    // to flapA in the weighted pool.
    let n = 0;
    const rand = () => (n++ === 0 ? 0.6 : 0.85);
    const ready: PetState = { activity: "idle", phase: "stand", facing: 1, x: 0, ticks: 1, hopsLeft: 0, chirp: 0, sinceInteract: 0, dozeAfter: 9999 };
    const flap = advancePet(ready, ctx({ rand }));
    expect(flap.phase).toBe("flapA");
    expect(flap.hopsLeft).toBeGreaterThan(0); // seeded flutter counter
    const flap2 = advancePet(flap, ctx());
    expect(flap2.phase).toBe("flapB"); // alternates to the paired frame
  });
});

describe("advancePet — doze after a long idle", () => {
  it("a stand pause that expires past the doze threshold settles into a doze", () => {
    const nearDoze: PetState = { activity: "idle", phase: "stand", facing: 1, x: 5, ticks: 1, hopsLeft: 0, chirp: 0, sinceInteract: 500, dozeAfter: 300 };
    const s = advancePet(nearDoze, ctx());
    expect(s.activity).toBe("doze");
    expect(s.phase).toBe("doze");
  });

  it("a dozing bird stays asleep across ticks until something happens", () => {
    const dozing: PetState = { activity: "doze", phase: "doze", facing: 1, x: 5, ticks: 1, hopsLeft: 0, chirp: 0, sinceInteract: 500, dozeAfter: 300 };
    const s = run(dozing, 10, ctx());
    expect(s.activity).toBe("doze");
    expect(s.phase).toBe("doze");
  });

  it("a new in-flight request wakes the dozing bird with a startle hop into attentive", () => {
    const dozing: PetState = { activity: "doze", phase: "doze", facing: 1, x: 5, ticks: 1, hopsLeft: 0, chirp: 0, sinceInteract: 500, dozeAfter: 300 };
    const s = advancePet(dozing, ctx({ inFlight: true }));
    expect(s.activity).toBe("attentive");
    expect(s.phase).toBe("hopUp");
  });

  it("a completed response wakes a dozing bird happily (hop + chirp)", () => {
    const dozing: PetState = { activity: "doze", phase: "doze", facing: 1, x: 5, ticks: 1, hopsLeft: 0, chirp: 0, sinceInteract: 500, dozeAfter: 300 };
    const s = advancePet(dozing, ctx({ completed: true }));
    expect(s.phase).toBe("hopUp");
    expect(s.chirp).toBeGreaterThan(0);
  });
});

describe("advancePet — error fluster", () => {
  it("a failed request triggers a shiver (ruffle) that settles through a brief droop back to idle", () => {
    const flust = advancePet(initialPetState(), ctx({ errored: true }));
    expect(flust.activity).toBe("fluster");
    expect(flust.phase).toBe("ruffleA");

    const drooped = run(flust, 4, ctx());
    expect(drooped.phase).toBe("droop");

    const settled = run(flust, 8, ctx());
    expect(settled.activity).toBe("idle");
    expect(settled.phase).toBe("stand");
  });

  it("an error resets the doze timer (interaction happened)", () => {
    const almostDozing: PetState = { activity: "idle", phase: "stand", facing: 1, x: 0, ticks: 4, hopsLeft: 0, chirp: 0, sinceInteract: 900, dozeAfter: 300 };
    const s = advancePet(almostDozing, ctx({ errored: true }));
    expect(s.sinceInteract).toBe(0);
  });
});

describe("advancePet — wander motion", () => {
  const wander: PetState = { activity: "wander", phase: "hopUp", facing: 1, x: 0, ticks: 1, hopsLeft: 2, chirp: 0 };

  it("a landed hop translates x by the hop step in the facing direction", () => {
    const s = advancePet(wander, ctx());
    expect(s.phase).toBe("hopLand");
    expect(s.x).toBe(4); // HOP_STEP
    expect(s.hopsLeft).toBe(1);
  });

  it("a wander burst returns to an idle stand once its hops are spent, having moved", () => {
    // hopUp→land(x=4), land→hopUp, hopUp→land(x=8, hopsLeft 0 → idle)
    const s = run(wander, 3, ctx());
    expect(s.activity).toBe("idle");
    expect(s.phase).toBe("stand");
    expect(s.x).toBe(8);
  });

  it("flips facing at the right edge (edge awareness)", () => {
    const atEdge: PetState = { activity: "wander", phase: "hopUp", facing: 1, x: 98, ticks: 1, hopsLeft: 2, chirp: 0 };
    const s = advancePet(atEdge, ctx());
    expect(s.x).toBe(100); // clamped to max
    expect(s.facing).toBe(-1); // turned around
  });
});

describe("advancePet — reactive to chat", () => {
  it("an in-flight request forces attentive from idle (stops wandering)", () => {
    const s = advancePet(initialPetState(), ctx({ inFlight: true }));
    expect(s.activity).toBe("attentive");
    expect(s.phase).toBe("attend");
  });

  it("an in-flight request forces attentive from mid-wander too", () => {
    const wander: PetState = { activity: "wander", phase: "hopUp", facing: 1, x: 20, ticks: 1, hopsLeft: 3, chirp: 0 };
    const s = advancePet(wander, ctx({ inFlight: true }));
    expect(s.activity).toBe("attentive");
  });

  it("a completed response triggers a happy hop + a 2-note chirp", () => {
    const attentive: PetState = { activity: "attentive", phase: "attend", facing: 1, x: 20, ticks: 4, hopsLeft: 0, chirp: 0 };
    const s = advancePet(attentive, ctx({ inFlight: false, completed: true }));
    expect(s.chirp).toBeGreaterThan(0);
    expect(s.activity).toBe("wander");
    expect(s.phase).toBe("hopUp");
  });

  it("when the request ends (no completion edge) attentive relaxes back to idle", () => {
    const attentive: PetState = { activity: "attentive", phase: "attend", facing: 1, x: 20, ticks: 4, hopsLeft: 0, chirp: 0 };
    const s = advancePet(attentive, ctx({ inFlight: false, completed: false }));
    expect(s.activity).toBe("idle");
    expect(s.phase).toBe("stand");
  });

  it("the chirp counter decays each tick", () => {
    const withChirp: PetState = { ...initialPetState(), chirp: 3 };
    const s = advancePet(withChirp, ctx());
    expect(s.chirp).toBe(2);
  });
});

describe("staticPetState — reduced motion", () => {
  it("never wanders even if ticked (stays a standing pose in place)", () => {
    const s = run(staticPetState(50), 20, ctx());
    expect(s.activity).toBe("idle");
    expect(s.phase).toBe("stand");
    expect(s.x).toBe(50);
  });
});
