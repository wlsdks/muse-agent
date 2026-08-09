import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ACTUATOR_MODE,
  isActuatorMode,
  normalizeActuatorConfig,
  readActuatorConfig,
  readActuatorConfigSafe,
  resolveActuatorMode,
  writeActuatorConfig
} from "../src/actuator-mode.js";

async function configFile(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muse-actuator-mode-"));
  const file = join(dir, "config.json");
  if (contents !== undefined) await writeFile(file, contents, "utf8");
  return file;
}

describe("actuator mode — the setting fails CLOSED", () => {
  it("defaults to off, so an untouched install exposes no actuators", async () => {
    expect(DEFAULT_ACTUATOR_MODE).toBe("off");
    expect((await readActuatorConfig(await configFile())).mode).toBe("off");
    expect(normalizeActuatorConfig(undefined).mode).toBe("off");
  });

  it("falls back to off for an UNRECOGNISED mode rather than guessing at a typo", () => {
    // The dangerous alternative is fuzzy-matching "Auto"/"automatic" to `auto`:
    // a config typo must never widen what Muse may do.
    for (const bad of ["automatic", "AUTO ", "on", "true", "", 1, null, {}, []]) {
      expect(normalizeActuatorConfig({ mode: bad }).mode).toBe("off");
    }
  });

  it("accepts exactly the three known modes", () => {
    for (const mode of ["off", "ask", "auto"]) {
      expect(isActuatorMode(mode)).toBe(true);
      expect(normalizeActuatorConfig({ mode }).mode).toBe(mode);
    }
    expect(isActuatorMode("AUTO")).toBe(false);
  });

  it("resolves a corrupt config to off instead of throwing mid-turn", async () => {
    expect((await readActuatorConfigSafe(await configFile("{ not json"))).mode).toBe("off");
    expect((await readActuatorConfigSafe(await configFile('"a string"'))).mode).toBe("off");
    // The strict reader still reports loudly for surfaces that want the error.
    await expect(readActuatorConfig(await configFile("{ not json"))).rejects.toThrow(/not valid JSON/u);
  });
});

describe("actuator mode — env precedence", () => {
  it("lets MUSE_ACTUATOR_MODE override the configured mode", () => {
    expect(resolveActuatorMode({ MUSE_ACTUATOR_MODE: "ask" }, "off")).toBe("ask");
    expect(resolveActuatorMode({ MUSE_ACTUATOR_MODE: "off" }, "auto")).toBe("off");
    expect(resolveActuatorMode({ MUSE_ACTUATOR_MODE: " AUTO " }, "off")).toBe("auto");
  });

  it("ignores an unrecognised env value instead of forcing off", () => {
    // Falling through to the configured value is safe: that value was itself
    // user-chosen. Forcing `off` would let a shell typo silently disable a
    // mode the user durably set.
    expect(resolveActuatorMode({ MUSE_ACTUATOR_MODE: "automatic" }, "ask")).toBe("ask");
    expect(resolveActuatorMode({}, "auto")).toBe("auto");
  });
});

describe("actuator mode — persistence", () => {
  it("round-trips through the shared config file", async () => {
    const file = await configFile();
    await writeActuatorConfig(file, { mode: "ask" });
    expect((await readActuatorConfig(file)).mode).toBe("ask");
  });

  it("preserves unrelated config blocks and, on POSIX, keeps the file 0600", async () => {
    const file = await configFile(`${JSON.stringify({ dayRhythm: { enabled: true }, defaultModel: "ollama/gemma4:12b" }, null, 2)}\n`);
    await writeActuatorConfig(file, { mode: "auto" });

    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(parsed.defaultModel).toBe("ollama/gemma4:12b");
    expect(parsed.dayRhythm).toEqual({ enabled: true });
    expect(parsed.actuators).toEqual({ mode: "auto" });

    if (process.platform !== "win32") {
      const { mode } = await import("node:fs/promises").then(async (fs) => fs.stat(file));
      expect(mode & 0o777).toBe(0o600);
    }
  });
});
