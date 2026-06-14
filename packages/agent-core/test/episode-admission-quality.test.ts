import { describe, expect, it } from "vitest";

import { classifyEpisodeAdmissionQuality, type SessionTurnLine } from "../src/index.js";

// Selective addition (arXiv:2505.16067): a stored episode replays its outcome via
// experience-following, so an error-prone session (more corrections than approvals)
// should not be admitted to the episode store.

const u = (content: string): SessionTurnLine => ({ content, role: "user" });
const a = (content: string): SessionTurnLine => ({ content, role: "assistant" });

describe("classifyEpisodeAdmissionQuality", () => {
  it("error-prone: a corrected session (correction > approval) is NOT admitted", () => {
    const r = classifyEpisodeAdmissionQuality([
      u("what's the capital of Australia?"),
      a("Sydney."),
      u("no, that's wrong — it's Canberra")
    ]);
    expect(r.admit).toBe(false);
    expect(r.label).toBe("error-prone");
    expect(r.corrections).toBeGreaterThan(r.approvals);
  });

  it("quality: an approved session is admitted", () => {
    const r = classifyEpisodeAdmissionQuality([
      u("summarise the plan"),
      a("Here is the plan: …"),
      u("perfect, thanks!")
    ]);
    expect(r.admit).toBe(true);
    expect(r.label).toBe("quality");
  });

  it("default-keep: a neutral session with no correction/approval signal is admitted", () => {
    const r = classifyEpisodeAdmissionQuality([
      u("what time is the meeting?"),
      a("3pm."),
      u("got it")
    ]);
    expect(r.admit).toBe(true);
    expect(r.corrections).toBe(0);
  });

  it("tie → admit (conservative): an approval that offsets a correction is kept", () => {
    const r = classifyEpisodeAdmissionQuality([
      u("draft the email"),
      a("draft v1"),
      u("no, that's wrong"),
      a("draft v2"),
      u("perfect")
    ]);
    expect(r.corrections).toBe(1);
    expect(r.approvals).toBe(1);
    expect(r.admit).toBe(true); // corrections not > approvals
  });

  it("Korean correction is detected (error-prone)", () => {
    const r = classifyEpisodeAdmissionQuality([
      u("호주 수도가 어디야?"),
      a("시드니입니다."),
      u("아니야, 틀렸어 — 캔버라야")
    ]);
    expect(r.admit).toBe(false);
  });
});
