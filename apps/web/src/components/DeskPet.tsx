import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import { createCelebration, createPetController } from "./desk-pet-controller.js";
import { initialPetState } from "./desk-pet-machine.js";
import {
  BIRD_H,
  BIRD_W,
  chirpBoxShadow,
  frameToBoxShadow,
  FRAMES,
  heartBoxShadow,
  noteBoxShadow,
  PIXEL,
  zzzBoxShadow
} from "./pixel-bird.js";

import type { Celebration } from "./desk-pet-controller.js";
import type { PetState } from "./desk-pet-machine.js";

const FRAME_SHADOWS: Record<string, string> = Object.fromEntries(
  Object.entries(FRAMES).map(([name, frame]) => [name, frameToBoxShadow(frame)])
);
const CHIRP_SHADOW = chirpBoxShadow();
const ZZZ_SHADOW = zzzBoxShadow();
const NOTE_SHADOW = noteBoxShadow();
const HEART_SHADOW = heartBoxShadow();

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Imperative handle so praise-detection can later pop the celebrate heart. */
export interface DeskPetHandle {
  celebrate: () => void;
}

/**
 * A tiny pixel bluebird (파랑새) that lives on the top edge of the chat composer.
 * Ambient and non-interactive: absolutely positioned + `pointer-events:
 * none`, so it never affects the composer's layout or steals clicks.
 *
 * `boundsRef` is the composer wrapper; the bird wanders within its width.
 * `inFlight` is the chat pending flag — attentive pose + happy hop/chirp when a
 * response lands. `error` is the chat error — a new value triggers a fluster.
 * A long idle settles the bird into a doze (blinking "z"); an occasional idle
 * sing drifts muted notes up. `celebrate()` pops a heart (reserved hook).
 */
export const DeskPet = forwardRef<DeskPetHandle, { boundsRef: React.RefObject<HTMLElement | null>; inFlight: boolean; error?: string | null }>(
  function DeskPet({ boundsRef, inFlight, error }, ref) {
    const [state, setState] = useState<PetState>(() => initialPetState());
    const [heart, setHeart] = useState(false);
    const inputsRef = useRef({ inFlight, width: 0, error: error ?? null });
    inputsRef.current.inFlight = inFlight;
    inputsRef.current.error = error ?? null;

    const celebrationRef = useRef<Celebration | null>(null);
    if (celebrationRef.current === null) {
      celebrationRef.current = createCelebration(setHeart);
    }
    useImperativeHandle(ref, () => ({ celebrate: () => celebrationRef.current?.fire() }), []);

    useEffect(() => {
      const el = boundsRef.current;
      const reduced = prefersReducedMotion();

      const measure = () => {
        inputsRef.current.width = el?.clientWidth ?? 0;
      };
      measure();

      let observer: ResizeObserver | undefined;
      if (el && typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(measure);
        observer.observe(el);
      }

      const controller = createPetController({
        reducedMotion: reduced,
        getInputs: () => ({
          inFlight: inputsRef.current.inFlight,
          error: inputsRef.current.error,
          bounds: { min: 0, max: Math.max(0, inputsRef.current.width - BIRD_W) }
        }),
        onFrame: setState
      });
      controller.start();

      return () => {
        controller.stop();
        observer?.disconnect();
        celebrationRef.current?.cancel();
      };
    }, [boundsRef]);

    const dozing = state.phase === "doze";
    const singing = state.phase === "sing";

    return (
      <div className="desk-pet" aria-hidden="true" style={{ width: BIRD_W, height: BIRD_H, transform: `translateX(${state.x}px)` }}>
        <div className="desk-pet-flip" style={{ transform: state.facing === -1 ? "scaleX(-1)" : "none" }}>
          <span
            className="desk-pet-px"
            data-frame={state.phase}
            style={{ width: PIXEL, height: PIXEL, boxShadow: FRAME_SHADOWS[state.phase] }}
          />
          {state.chirp > 0 && <span className="desk-pet-chirp" style={{ width: PIXEL, height: PIXEL, boxShadow: CHIRP_SHADOW }} />}
          {dozing && <span className="desk-pet-zzz" style={{ width: PIXEL, height: PIXEL, boxShadow: ZZZ_SHADOW }} />}
          {singing && <span className="desk-pet-note" style={{ width: PIXEL, height: PIXEL, boxShadow: NOTE_SHADOW }} />}
          {heart && <span className="desk-pet-heart" style={{ width: PIXEL, height: PIXEL, boxShadow: HEART_SHADOW }} />}
        </div>
      </div>
    );
  }
);
