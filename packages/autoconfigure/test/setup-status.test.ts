import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LOCAL_FIRST_DEFAULT_MODEL, resolveDefaultModel } from "../src/autoconfigure-model-provider.js";
import { buildModelSection, readActuatorReadiness, readConfigDefaultModel, readModelKeyState, readWebSearchEnvSnapshot, resolveVoiceStatus } from "../src/setup-status.js";

const MISSING_KEYS_FILE = "/dev/null/no-such-keys.json";
const KEYS_FILE = "/c/models.json";

describe("buildModelSection — model section mirrors `muse doctor`'s resolver", () => {
  it("fresh box (no MUSE_MODEL, no cloud key, no config) → status ok, names the LOCAL default, no cloud-led hint", () => {
    // Regression for the release-blocker: setup used to report `todo`/"not
    // configured" while doctor reported the local default as ready.
    const section = buildModelSection({}, { keysFile: KEYS_FILE, providerKeys: [] });
    expect(section.status).toBe("ok");
    expect(section.resolvedModel).toBe(LOCAL_FIRST_DEFAULT_MODEL);
    expect(section.resolvedModel).toBe("ollama/gemma4:12b");
    expect(section.modelSource).toBe("local-default");
    // muse_model stays env-truthful — it is NOT set from the default.
    expect(section.muse_model).toBeUndefined();
    // The next step must not push cloud vendors on a local-first user; it is a
    // soft customize nudge that leads with the local path.
    expect(section.nextStep).toContain("local default");
    expect(section.nextStep).not.toMatch(/^Run `muse setup model`/u);
    expect(section.nextStep!.indexOf("muse setup local")).toBeLessThan(section.nextStep!.indexOf("muse setup model"));
  });

  it("explicit MUSE_MODEL → status ok, muse_model + resolvedModel echo it, source env", () => {
    const section = buildModelSection({ MUSE_MODEL: "ollama/qwen3.5:9b" }, { keysFile: KEYS_FILE, providerKeys: [] });
    expect(section).toMatchObject({
      modelSource: "env",
      muse_model: "ollama/qwen3.5:9b",
      resolvedModel: "ollama/qwen3.5:9b",
      status: "ok"
    });
  });

  it("persisted config defaultModel (no env) → credited, source config", () => {
    const section = buildModelSection({}, { configDefaultModel: "ollama/gemma4:12b", keysFile: KEYS_FILE, providerKeys: [] });
    expect(section).toMatchObject({ modelSource: "config", resolvedModel: "ollama/gemma4:12b", status: "ok" });
    expect(section.muse_model).toBeUndefined();
  });

  it("ambient cloud key (local-only off) → cloud model inferred, source cloud, still ok", () => {
    const section = buildModelSection({ GEMINI_API_KEY: "g" }, { keysFile: KEYS_FILE, providerKeys: ["gemini (env)"] });
    expect(section.status).toBe("ok");
    expect(section.modelSource).toBe("cloud");
    expect(section.resolvedModel).toBe(resolveDefaultModel({ GEMINI_API_KEY: "g" }));
    expect(section.resolvedModel).toMatch(/^gemini\//u);
  });

  it("local-only on with a stray cloud key → key IGNORED, falls to the local default", () => {
    const section = buildModelSection(
      { GEMINI_API_KEY: "g", MUSE_LOCAL_ONLY: "true" },
      { keysFile: KEYS_FILE, providerKeys: ["gemini (env)"] }
    );
    expect(section.modelSource).toBe("local-default");
    expect(section.resolvedModel).toBe(LOCAL_FIRST_DEFAULT_MODEL);
  });

  it("explicit MUSE_MODEL wins over a persisted config default", () => {
    const section = buildModelSection(
      { MUSE_MODEL: "ollama/qwen3.5:2b-q4_K_M" },
      { configDefaultModel: "ollama/gemma4:12b", keysFile: KEYS_FILE, providerKeys: [] }
    );
    expect(section).toMatchObject({ modelSource: "env", resolvedModel: "ollama/qwen3.5:2b-q4_K_M" });
  });
});

describe("readConfigDefaultModel", () => {
  it("reads defaultModel from a config.json", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "muse-cfg-"));
    const file = join(dir, "config.json");
    await fs.writeFile(file, JSON.stringify({ apiUrl: "http://x", defaultModel: "ollama/gemma4:12b" }), "utf8");
    expect(await readConfigDefaultModel(file)).toBe("ollama/gemma4:12b");
  });

  it("returns undefined when the file is missing, blank, or has no defaultModel", async () => {
    expect(await readConfigDefaultModel("/dev/null/nope.json")).toBeUndefined();
    const dir = await fs.mkdtemp(join(tmpdir(), "muse-cfg-"));
    const empty = join(dir, "config.json");
    await fs.writeFile(empty, JSON.stringify({ apiUrl: "http://x", defaultModel: "   " }), "utf8");
    expect(await readConfigDefaultModel(empty)).toBeUndefined();
  });
});

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
