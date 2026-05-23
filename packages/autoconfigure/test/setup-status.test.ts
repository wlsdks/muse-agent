import { describe, expect, it } from "vitest";

import { resolveDefaultModel } from "../src/autoconfigure-model-provider.js";
import { readActuatorReadiness, readModelKeyState, readWebSearchEnvSnapshot, resolveVoiceStatus } from "../src/setup-status.js";

const MISSING_KEYS_FILE = "/dev/null/no-such-keys.json";

describe("resolveVoiceStatus", () => {
  it("piper requested but MUSE_PIPER_VOICE unset → warns it silently fell back to paid OpenAI TTS", () => {
    const v = resolveVoiceStatus({ MUSE_VOICE_TTS: "piper", OPENAI_API_KEY: "sk-test" });
    // Effective backend is the paid fallback, NOT what the user asked for.
    expect(v.ttsBackend).toBe("openai-tts");
    expect(v.nextStep).toContain("MUSE_PIPER_VOICE");
    expect(v.nextStep).toContain("fell back to openai-tts");
  });

  it("piper requested WITH MUSE_PIPER_VOICE → local backend, no fallback warning", () => {
    const v = resolveVoiceStatus({ MUSE_VOICE_TTS: "piper", MUSE_PIPER_VOICE: "/voices/en.onnx" });
    expect(v.ttsBackend).toBe("piper");
    expect(v.nextStep).toBeUndefined();
  });

  it("nothing configured → status info + the full setup hint", () => {
    const v = resolveVoiceStatus({});
    expect(v).toMatchObject({ source: "none", sttBackend: "none", status: "info", ttsBackend: "none" });
    expect(v.nextStep).toContain("MUSE_VOICE_STT=whisper-cpp");
  });

  it("openai key only → both openai backends, no warning", () => {
    const v = resolveVoiceStatus({ MUSE_VOICE_OPENAI_API_KEY: "sk-x" });
    expect(v).toMatchObject({ source: "muse_voice_openai_api_key", sttBackend: "openai-whisper", status: "ok", ttsBackend: "openai-tts" });
    expect(v.nextStep).toBeUndefined();
  });
});

describe("readActuatorReadiness", () => {
  it("reports web always-on, email/home off, status info + hints when no provider env is set", () => {
    const snap = readActuatorReadiness({});
    expect(snap).toMatchObject({ email: false, home: false, status: "info", web: true });
    expect(snap.nextStep).toContain("MUSE_GMAIL_TOKEN");
    expect(snap.nextStep).toContain("MUSE_HOMEASSISTANT_URL");
    expect(snap.nextStep).toContain("--actuators");
  });

  it("flips email + status to ok when MUSE_GMAIL_TOKEN is set, still hinting the missing home actuator", () => {
    const snap = readActuatorReadiness({ MUSE_GMAIL_TOKEN: "tok" });
    expect(snap).toMatchObject({ email: true, home: false, status: "ok" });
    expect(snap.nextStep).toContain("MUSE_HOMEASSISTANT_URL");
    expect(snap.nextStep).not.toContain("MUSE_GMAIL_TOKEN");
  });

  it("requires BOTH Home Assistant vars to mark home ready", () => {
    expect(readActuatorReadiness({ MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" }).home).toBe(false);
    expect(
      readActuatorReadiness({ MUSE_HOMEASSISTANT_TOKEN: "ha", MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" }).home
    ).toBe(true);
  });

  it("drops the nextStep entirely once every provider-backed actuator is configured", () => {
    const snap = readActuatorReadiness({
      MUSE_GMAIL_TOKEN: "tok",
      MUSE_HOMEASSISTANT_TOKEN: "ha",
      MUSE_HOMEASSISTANT_URL: "http://ha.local:8123"
    });
    expect(snap).toMatchObject({ email: true, home: true, status: "ok", web: true });
    expect(snap.nextStep).toBeUndefined();
  });
});

describe("readWebSearchEnvSnapshot", () => {
  it("returns enabled=true, maxUses=5, source=default when no env vars set", () => {
    expect(readWebSearchEnvSnapshot({})).toEqual({
      enabled: true,
      maxUses: 5,
      source: "default"
    });
  });

  it("MUSE_WEB_SEARCH=off flips enabled to false with source=env", () => {
    expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH: "off" })).toEqual({
      enabled: false,
      maxUses: 5,
      source: "env"
    });
  });

  it("MUSE_WEB_SEARCH=on is the explicit-enable form with source=env", () => {
    expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH: "on" })).toEqual({
      enabled: true,
      maxUses: 5,
      source: "env"
    });
  });

  it("MUSE_WEB_SEARCH_MAX_USES overrides default maxUses when positive", () => {
    expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH_MAX_USES: "12" })).toEqual({
      enabled: true,
      maxUses: 12,
      source: "env"
    });
  });

  it("non-positive MUSE_WEB_SEARCH_MAX_USES falls back to default 5", () => {
    expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH_MAX_USES: "abc" })).toEqual({
      enabled: true,
      maxUses: 5,
      source: "default"
    });
  });

  it("a lenient-prefix typo / unit-slip MUSE_WEB_SEARCH_MAX_USES is rejected, not reported as env-configured", () => {
    // Number.parseInt("5x") === 5 — the 414/444 footgun. On the
    // setup-status surface a typo must NOT show as a valid value.
    for (const bad of ["5x", "30s", "12abc", "1_000", "0", "-3", " "]) {
      expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH_MAX_USES: bad })).toEqual({
        enabled: true,
        maxUses: 5,
        source: "default"
      });
    }
    // No regression: a clean positive integer still configures it.
    expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH_MAX_USES: "8" })).toEqual({
      enabled: true,
      maxUses: 8,
      source: "env"
    });
  });

  it("OFF flag is case-insensitive (OFF / Off / off all disable)", () => {
    for (const value of ["OFF", "Off", "off"]) {
      expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH: value }).enabled).toBe(false);
    }
  });

  it("accepts every standard falsy spelling (false / 0 / no / off) as a kill switch", () => {
    for (const value of ["false", "False", "FALSE", "0", "no", "NO", "off", "Off"]) {
      expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH: value })).toEqual({
        enabled: false,
        maxUses: 5,
        source: "env"
      });
    }
  });

  it("accepts every standard truthy spelling (true / 1 / yes / on) as an explicit enable", () => {
    for (const value of ["true", "True", "TRUE", "1", "yes", "YES", "on", "On"]) {
      expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH: value })).toEqual({
        enabled: true,
        maxUses: 5,
        source: "env"
      });
    }
  });

  it("unrecognised MUSE_WEB_SEARCH spellings keep source=default — typo does not silently flip the snapshot", () => {
    for (const value of ["enabled", "disabled", "y", "n", "  ", "xyz", "truue"]) {
      expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH: value })).toEqual({
        enabled: true,
        maxUses: 5,
        source: "default"
      });
    }
  });
});

describe("readModelKeyState — provider key probing", () => {
  it("detects GROQ_API_KEY", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, { GROQ_API_KEY: "grq" });
    expect(lines).toContain("groq (env)");
  });

  it("detects DEEPSEEK_API_KEY", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, { DEEPSEEK_API_KEY: "ds" });
    expect(lines).toContain("deepseek (env)");
  });

  it("detects TOGETHER_API_KEY", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, { TOGETHER_API_KEY: "tg" });
    expect(lines).toContain("together (env)");
  });

  it("detects MISTRAL_API_KEY", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, { MISTRAL_API_KEY: "ms" });
    expect(lines).toContain("mistral (env)");
  });

  it("detects MOONSHOT_API_KEY", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, { MOONSHOT_API_KEY: "mn" });
    expect(lines).toContain("moonshot (env)");
  });

  it("keeps the legacy providers (openai/anthropic/gemini/openrouter/ollama)", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, {
      OPENAI_API_KEY: "o",
      ANTHROPIC_API_KEY: "a",
      GEMINI_API_KEY: "g",
      OPENROUTER_API_KEY: "or",
      OLLAMA_BASE_URL: "http://localhost:11434"
    });
    expect(lines).toEqual([
      "openai (env)",
      "anthropic (env)",
      "gemini (env)",
      "openrouter (env)",
      "ollama (env)"
    ]);
  });
});

describe("readModelKeyState ↔ resolveDefaultModel parity", () => {
  const probedKeys: ReadonlyArray<{ id: string; envKey: string; envValue: string }> = [
    { envKey: "OPENAI_API_KEY", envValue: "t", id: "openai" },
    { envKey: "ANTHROPIC_API_KEY", envValue: "t", id: "anthropic" },
    { envKey: "GEMINI_API_KEY", envValue: "t", id: "gemini" },
    { envKey: "OPENROUTER_API_KEY", envValue: "t", id: "openrouter" },
    { envKey: "OLLAMA_BASE_URL", envValue: "http://localhost:11434", id: "ollama" },
    { envKey: "GROQ_API_KEY", envValue: "t", id: "groq" },
    { envKey: "DEEPSEEK_API_KEY", envValue: "t", id: "deepseek" },
    { envKey: "TOGETHER_API_KEY", envValue: "t", id: "together" },
    { envKey: "MISTRAL_API_KEY", envValue: "t", id: "mistral" },
    { envKey: "MOONSHOT_API_KEY", envValue: "t", id: "moonshot" },
    { envKey: "CEREBRAS_API_KEY", envValue: "t", id: "cerebras" }
  ];

  for (const { id, envKey, envValue } of probedKeys) {
    it(`${id}: probe detects key AND resolveDefaultModel picks a model`, async () => {
      const env = { [envKey]: envValue };
      const probed = await readModelKeyState(MISSING_KEYS_FILE, env);
      expect(probed).toContain(`${id} (env)`);
      const model = resolveDefaultModel(env);
      expect(model, `${id} key is probed but resolveDefaultModel returned undefined`).toBeDefined();
      expect(model).toMatch(/\S/);
    });
  }
});
