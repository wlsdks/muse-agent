import { describe, expect, it } from "vitest";

import {
  describeCapabilities,
  describeCapabilitiesEn,
  describeCapabilitiesKo,
  type CapabilityEnv
} from "../src/capability-describer.js";

const EMPTY: CapabilityEnv = {};

describe("describeCapabilities — honest, job-grouped, env-aware", () => {
  it("names capabilities from every job group (no longer the notes-only slice)", () => {
    const ko = describeCapabilitiesKo(EMPTY);
    // ≥5 job groups must be legible — proving the answer covers the whole
    // product, not just notes citation. Dropping any group turns its line RED.
    expect(ko, "memory/notes group").toMatch(/기억|muse recall/u);
    expect(ko, "calendar/reminders group").toMatch(/일정|muse calendar/u);
    expect(ko, "briefing group").toMatch(/브리핑|muse brief/u);
    expect(ko, "grounded-recall group").toMatch(/근거|muse ask/u);
    expect(ko, "actions/email group").toMatch(/이메일/u);
    expect(ko, "chat-channel group").toMatch(/텔레그램/u);
    expect(ko, "orchestration group").toMatch(/오케스트레이션|muse orchestrate/u);
  });

  it("shows an un-armed integration's setup command, never 'connected'", () => {
    const ko = describeCapabilitiesKo(EMPTY);
    expect(ko).toContain("set MUSE_GMAIL_TOKEN");
    expect(ko).not.toContain("이메일: 연결됨");
    const en = describeCapabilitiesEn(EMPTY);
    expect(en).toContain("set MUSE_GMAIL_TOKEN");
    expect(en).not.toContain("Email: connected");
  });

  it("shows an armed integration as connected, without its setup command", () => {
    const armed: CapabilityEnv = { MUSE_GMAIL_TOKEN: "ya29.token" };
    const ko = describeCapabilitiesKo(armed);
    expect(ko).toContain("이메일: 연결됨");
    expect(ko).not.toContain("이메일: 사용 가능");
    const en = describeCapabilitiesEn(armed);
    expect(en).toContain("Email: connected");
  });

  it("reflects each integration's own armed state independently", () => {
    const homeOnly: CapabilityEnv = {
      MUSE_HOMEASSISTANT_URL: "http://ha.local:8123",
      MUSE_HOMEASSISTANT_TOKEN: "ha-token"
    };
    const en = describeCapabilitiesEn(homeOnly);
    expect(en).toContain("Smart home: connected");
    // Email still un-armed → still shows its setup command, never connected.
    expect(en).toContain("Email: available");
    expect(en).toContain("set MUSE_GMAIL_TOKEN");
  });

  it("is deterministic — same env + language always yields the same string", () => {
    const env: CapabilityEnv = { MUSE_TELEGRAM_BOT_TOKEN: "bot123" };
    expect(describeCapabilitiesKo(env)).toBe(describeCapabilitiesKo(env));
    expect(describeCapabilitiesEn(env)).toBe(describeCapabilitiesEn(env));
    // Never model-generated: the dispatcher matches the named variants exactly.
    expect(describeCapabilities(env, true)).toBe(describeCapabilitiesKo(env));
    expect(describeCapabilities(env, false)).toBe(describeCapabilitiesEn(env));
    expect(describeCapabilities(env)).toBe(describeCapabilitiesKo(env)); // Korean default
  });

  it("stays honest — leads with the local identity and never leaks data off-device", () => {
    const ko = describeCapabilitiesKo(EMPTY);
    expect(ko).toMatch(/개인 JARVIS/u);
    expect(ko).toMatch(/밖으로 나가지 않아/u);
    const en = describeCapabilitiesEn(EMPTY);
    expect(en).toMatch(/nothing leaves it/u);
    expect(en).toMatch(/not sure/u);
  });
});
