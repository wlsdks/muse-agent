import { describe, expect, it } from "vitest";

import {
  calibratePreferenceConfidence,
  DEFAULT_PREFERENCE_DISTRACTOR_FLOOR,
  inferPreferenceFromCorrection
} from "../src/index.js";

// DINCO (arXiv:2509.25532): recalibrate a verbalized confidence by normalizing it
// against the model's confidence on self-generated incompatible distractor traits.
// cal = c(orig) / (c(orig) + Σ c(distractors)); a trait that doesn't dominate is dropped.

function provider(output: string): { generate: () => Promise<{ output: string }> } {
  return { generate: () => Promise.resolve({ output }) };
}

describe("calibratePreferenceConfidence", () => {
  it("trait dominates its distractors → calibrated confidence (less saturated, < 1)", async () => {
    const p = provider("original: 0.9\nalt1: 0.1\nalt2: 0.1\nalt3: 0.1");
    const cal = await calibratePreferenceConfidence("give me bullet points", "prefers bullet points", 0.9, { model: "m", modelProvider: p as never });
    expect(cal).toBeCloseTo(0.9 / 1.2, 5); // 0.75
    expect(cal!).toBeLessThan(0.9); // less saturated than the raw verbalized confidence
  });

  it("distractors dominate → trait is dropped (undefined)", async () => {
    const p = provider("original: 0.2\nalt1: 0.9\nalt2: 0.8\nalt3: 0.7");
    const cal = await calibratePreferenceConfidence("ambiguous", "prefers X", 0.85, { model: "m", modelProvider: p as never });
    expect(cal).toBeUndefined(); // 0.2/2.6 ≈ 0.077 < floor
  });

  it("at-floor boundary respected", async () => {
    // original 0.34, distractors sum 0.66 → cal = 0.34 ≥ floor → kept.
    const p = provider("original: 0.34\nalt1: 0.22\nalt2: 0.22\nalt3: 0.22");
    const cal = await calibratePreferenceConfidence("c", "t", 0.5, { model: "m", modelProvider: p as never });
    expect(cal).toBeGreaterThanOrEqual(DEFAULT_PREFERENCE_DISTRACTOR_FLOOR);
  });

  it("fail-soft: a model error keeps the RAW confidence (never drops on error)", async () => {
    const p = { generate: () => Promise.reject(new Error("model down")) };
    const cal = await calibratePreferenceConfidence("c", "t", 0.77, { model: "m", modelProvider: p as never });
    expect(cal).toBe(0.77);
  });

  it("fail-soft: an unparseable response keeps the RAW confidence", async () => {
    const cal = await calibratePreferenceConfidence("c", "t", 0.6, { model: "m", modelProvider: provider("garbage no numbers") as never });
    expect(cal).toBe(0.6);
  });
});

// Assembled: inferPreferenceFromCorrection with calibrateConfidence:true. A
// call-counting provider returns the inference on call 1 and the calibration on
// call 2. (No embed → support gate skipped, isolating the calibration gate.)
function twoCallProvider(inference: string, calibration: string) {
  let n = 0;
  return {
    generate: () => {
      n += 1;
      return Promise.resolve({ output: n === 1 ? inference : calibration });
    }
  };
}

const INFERENCE_OK = "preference: prefers concise bullet-point answers\ncategory: format\nconfidence: 0.9";

describe("inferPreferenceFromCorrection — calibrateConfidence", () => {
  const exchange = { correction: "no, give me concise bullet points", priorAnswer: "Here is a long prose answer.", request: "summarise" };

  it("drops the preference when distractors dominate the calibration", async () => {
    const mp = twoCallProvider(INFERENCE_OK, "original: 0.2\nalt1: 0.9\nalt2: 0.8\nalt3: 0.9");
    const pref = await inferPreferenceFromCorrection(exchange, { calibrateConfidence: true, model: "m", modelProvider: mp as never });
    expect(pref).toBeUndefined();
  });

  it("keeps the preference with the CALIBRATED (lowered) confidence when the trait dominates", async () => {
    const mp = twoCallProvider(INFERENCE_OK, "original: 0.9\nalt1: 0.1\nalt2: 0.1\nalt3: 0.1");
    const pref = await inferPreferenceFromCorrection(exchange, { calibrateConfidence: true, model: "m", modelProvider: mp as never });
    expect(pref).toBeDefined();
    expect(pref!.confidence).toBeCloseTo(0.75, 5);
    expect(pref!.confidence).toBeLessThan(0.9); // calibrated below the raw verbalized 0.9
  });

  it("WITHOUT calibrateConfidence, the raw verbalized confidence is kept (revert behaviour)", async () => {
    const mp = twoCallProvider(INFERENCE_OK, "unused");
    const pref = await inferPreferenceFromCorrection(exchange, { model: "m", modelProvider: mp as never });
    expect(pref!.confidence).toBe(0.9);
  });
});
