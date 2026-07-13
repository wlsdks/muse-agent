import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_FIRST_DEFAULT_MODEL, resolveDefaultModel } from "../src/autoconfigure-model-provider.js";
import { buildModelSection, collectSetupStatusJson, evaluateLocalOnlyPosture, evaluateWebEgressStatus, readActuatorReadiness, readConfigDefaultModel, readMessagingProviderState, readModelKeyState, readWebSearchEnvSnapshot, resolveVoiceStatus } from "../src/setup-status.js";
import { resolveIntegrationEnvironment } from "../src/integration-environment.js";

const MISSING_KEYS_FILE = "/dev/null/no-such-keys.json";
const KEYS_FILE = "/c/models.json";
const SNAPSHOT_HIDDEN_INTEGRATION_KEYS = new Set([
  "MUSE_CALDAV_APP_PASSWORD",
  "MUSE_CALDAV_URL",
  "MUSE_CALDAV_USERNAME",
  "MUSE_CALENDAR_FILE",
  "MUSE_CALENDAR_ICS_FILE",
  "MUSE_CALENDAR_PROVIDERS",
  "MUSE_CHANNEL_OWNERS_FILE",
  "MUSE_CHANNEL_PAIRING_CODES_FILE",
  "MUSE_CREDENTIALS_FILE",
  "MUSE_DISCORD_AFTER_FILE",
  "MUSE_DISCORD_BOT_TOKEN",
  "MUSE_DISCORD_INBOX_FILE",
  "MUSE_DISCORD_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_GCAL_CALENDAR_ID",
  "MUSE_GCAL_CLIENT_ID",
  "MUSE_GCAL_CLIENT_SECRET",
  "MUSE_GCAL_REFRESH_TOKEN",
  "MUSE_LINE_CHANNEL_ACCESS_TOKEN",
  "MUSE_LINE_CHANNEL_SECRET",
  "MUSE_LINE_INBOX_FILE",
  "MUSE_LINE_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_MATRIX_ACCESS_TOKEN",
  "MUSE_MATRIX_HOMESERVER_URL",
  "MUSE_MATRIX_INBOX_FILE",
  "MUSE_MATRIX_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_MATRIX_SINCE_FILE",
  "MUSE_MESSAGING_CREDENTIALS_FILE",
  "MUSE_NOTION_DATABASE_ID",
  "MUSE_NOTION_TITLE_PROPERTY",
  "MUSE_NOTION_TOKEN",
  "MUSE_SLACK_AFTER_FILE",
  "MUSE_SLACK_BOT_TOKEN",
  "MUSE_SLACK_INBOX_FILE",
  "MUSE_SLACK_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_TELEGRAM_BOT_TOKEN",
  "MUSE_TELEGRAM_INBOX_FILE",
  "MUSE_TELEGRAM_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_TELEGRAM_OFFSET_FILE"
]);

function throwingIntegrationEnv(source: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return new Proxy(source, {
    get(target, property, receiver) {
      if (typeof property === "string" && SNAPSHOT_HIDDEN_INTEGRATION_KEYS.has(property)) {
        throw new Error(`ambient integration key read: ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property === "string" && SNAPSHOT_HIDDEN_INTEGRATION_KEYS.has(property)) {
        throw new Error(`ambient integration key descriptor read: ${property}`);
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    has(target, property) {
      if (typeof property === "string" && SNAPSHOT_HIDDEN_INTEGRATION_KEYS.has(property)) {
        throw new Error(`ambient integration key presence check: ${property}`);
      }
      return Reflect.has(target, property);
    },
    ownKeys: Reflect.ownKeys
  }) as NodeJS.ProcessEnv;
}

describe("evaluateWebEgressStatus — scoped local-only wording", () => {
  it("reports that T2-A1 closes Muse interactive public-web tools without claiming a whole-machine egress audit", () => {
    const status = evaluateWebEgressStatus({ MUSE_LOCAL_ONLY: "true", MUSE_WEB_EGRESS: "true" });
    expect(status.enabled).toBe(false);
    expect(status.detail).toContain("interactive public-web");
    expect(status.detail).toContain("not a complete all-egress audit");
  });
});

describe("evaluateLocalOnlyPosture — scoped MCP closure wording", () => {
  it("reports T2-A2 external MCP closure without claiming a whole-machine egress audit", () => {
    const status = evaluateLocalOnlyPosture({ MUSE_LOCAL_ONLY: "true", MUSE_MODEL: "ollama/llama3.2" });
    expect(status.detail).toContain("T2-A2");
    expect(status.detail).toContain("external MCP");
    expect(status.detail).toContain("not a complete all-egress audit");
  });
});

describe("T2-B1 setup-status containment", () => {
  it("does not read messaging credentials or token env under local-only", async () => {
    const originalReadFile = fs.readFile;
    let reads = 0;
    fs.readFile = (async (...args: Parameters<typeof originalReadFile>) => {
      reads += 1;
      return originalReadFile(...args);
    }) as typeof fs.readFile;
    try {
      expect(await readMessagingProviderState("/tmp/muse-t2b-messaging-sentinel.json", {
        MUSE_LOCAL_ONLY: "true",
        MUSE_TELEGRAM_BOT_TOKEN: "token"
      })).toEqual([]);
      expect(reads).toBe(0);
    } finally {
      fs.readFile = originalReadFile;
    }
  });

  it("uses a supplied normal snapshot for messaging labels instead of ambient policy, tokens, or credential files", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "muse-status-snapshot-messaging-"));
    const snapshotCredentials = join(root, "snapshot-messaging.json");
    const ambientCredentials = join(root, "ambient-messaging.json");
    try {
      await fs.writeFile(ambientCredentials, JSON.stringify({ providers: { telegram: { token: "ambient-file-token" } } }));
      const withoutTelegram = resolveIntegrationEnvironment({
        HOME: root,
        MUSE_LOCAL_ONLY: "false",
        MUSE_MESSAGING_CREDENTIALS_FILE: snapshotCredentials
      });
      expect(await readMessagingProviderState(ambientCredentials, {
        MUSE_LOCAL_ONLY: "true",
        MUSE_TELEGRAM_BOT_TOKEN: "ambient-token"
      }, withoutTelegram)).toEqual([]);

      const withTelegram = resolveIntegrationEnvironment({
        HOME: root,
        MUSE_LOCAL_ONLY: "false",
        MUSE_MESSAGING_CREDENTIALS_FILE: snapshotCredentials,
        MUSE_TELEGRAM_BOT_TOKEN: "snapshot-token"
      });
      expect(await readMessagingProviderState(ambientCredentials, { MUSE_LOCAL_ONLY: "true" }, withTelegram))
        .toEqual(["telegram (env)"]);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("keeps the no-snapshot CLI helper behavior visible from its supplied environment", async () => {
    expect(await readMessagingProviderState("/tmp/muse-t2b-missing-messaging.json", {
      MUSE_LOCAL_ONLY: "false",
      MUSE_TELEGRAM_BOT_TOKEN: "cli-token"
    })).toEqual(["telegram (env)"]);
  });

  it("masks ambient integration fields before a nonempty model-key merge for supplied normal snapshots", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "muse-status-snapshot-merge-"));
    const modelFile = join(root, "models.json");
    const snapshotCredentials = join(root, "snapshot-messaging.json");
    const ambientCredentials = join(root, "ambient-messaging.json");
    const previousEnv = process.env;
    const originalReadFile = fs.readFile;
    const reads: string[] = [];
    try {
      await fs.writeFile(modelFile, JSON.stringify({ providers: { openai: { suggestedModel: "openai/gpt-4.1-mini", token: "model-key" } } }));
      await fs.writeFile(snapshotCredentials, JSON.stringify({ providers: {} }));
      await fs.writeFile(ambientCredentials, JSON.stringify({ providers: { telegram: { token: "ambient-file-token" } } }));
      const snapshotBase = {
        HOME: root,
        MUSE_CALENDAR_FILE: join(root, "snapshot-calendar.json"),
        MUSE_CREDENTIALS_FILE: join(root, "snapshot-credentials.json"),
        MUSE_LOCAL_ONLY: "false",
        MUSE_MESSAGING_CREDENTIALS_FILE: snapshotCredentials
      };
      const withoutTelegram = resolveIntegrationEnvironment(snapshotBase);
      const withTelegram = resolveIntegrationEnvironment({ ...snapshotBase, MUSE_TELEGRAM_BOT_TOKEN: "snapshot-token" });
      expect(withoutTelegram.messaging.providers.telegram.envConfigured).toBe(false);
      expect(withTelegram.messaging.providers.telegram.envConfigured).toBe(true);

      fs.readFile = (async (...args: Parameters<typeof originalReadFile>) => {
        reads.push(String(args[0]));
        return originalReadFile(...args);
      }) as typeof fs.readFile;
      process.env = throwingIntegrationEnv({
        ...Object.fromEntries([...SNAPSHOT_HIDDEN_INTEGRATION_KEYS].map((key) => [key, join(root, `${key}.ambient`)])),
        HOME: root,
        // This is the normal/frozen-false compatibility control. Ambient
        // strictness is covered separately below and must now win there.
        MUSE_LOCAL_ONLY: "false",
        MUSE_MCP_CONFIG: join(root, "mcp.json"),
        MUSE_MESSAGING_CREDENTIALS_FILE: ambientCredentials,
        MUSE_MODEL_KEYS_FILE: modelFile,
        MUSE_NOTES_DIR: join(root, "notes"),
        MUSE_TASKS_FILE: join(root, "tasks.json")
      });

      const withoutTelegramStatus = await collectSetupStatusJson({ integrationEnv: withoutTelegram });
      const withTelegramStatus = await collectSetupStatusJson({ integrationEnv: withTelegram });
      expect(withoutTelegramStatus.localOnly).toMatchObject({ enabled: false });
      expect(withTelegramStatus.localOnly).toMatchObject({ enabled: false });
      expect(withoutTelegramStatus.messaging).toMatchObject({ providers: [], status: "info" });
      expect(withTelegramStatus.messaging).toMatchObject({ providers: ["telegram (env)"], status: "ok" });
      expect(withoutTelegramStatus.model).toMatchObject({ modelSource: "env", muse_model: "openai/gpt-4.1-mini" });
      expect(reads).toContain(snapshotCredentials);
      expect(reads).not.toContain(ambientCredentials);
    } finally {
      fs.readFile = originalReadFile;
      process.env = previousEnv;
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("uses a supplied local-only integration snapshot instead of ambient status posture", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "muse-status-local-only-"));
    const previous = process.env.MUSE_LOCAL_ONLY;
    const previousKeys = process.env.MUSE_MODEL_KEYS_FILE;
    const previousCalendar = process.env.MUSE_CALENDAR_FILE;
    const previousMessaging = process.env.MUSE_MESSAGING_CREDENTIALS_FILE;
    try {
      process.env.MUSE_LOCAL_ONLY = "false";
      process.env.MUSE_MODEL_KEYS_FILE = join(root, "models.json");
      process.env.MUSE_CALENDAR_FILE = join(root, "calendar.json");
      process.env.MUSE_MESSAGING_CREDENTIALS_FILE = join(root, "ambient-messaging.json");
      await fs.writeFile(join(root, "models.json"), JSON.stringify({ providers: {} }));
      await fs.writeFile(join(root, "credentials.json"), JSON.stringify({ providers: { gcal: { refreshToken: "secret" } } }));
      await fs.writeFile(join(root, "messaging.json"), JSON.stringify({ providers: { telegram: { token: "secret" } } }));

      const snapshot = await collectSetupStatusJson({
        integrationEnv: resolveIntegrationEnvironment({
          MUSE_CALENDAR_FILE: join(root, "calendar.json"),
          MUSE_CREDENTIALS_FILE: join(root, "credentials.json"),
          MUSE_LOCAL_ONLY: "true",
          MUSE_MESSAGING_CREDENTIALS_FILE: join(root, "messaging.json")
        })
      });

      expect(snapshot.localOnly.enabled).toBe(true);
      expect(snapshot.calendar.credentials).toEqual({
        file: join(root, "credentials.json"),
        nextStep: "Remote Google/CalDAV setup is disabled while MUSE_LOCAL_ONLY=true. Local file, exported ICS, and macOS Calendar.app remain available; set MUSE_MACOS_CALENDAR_NAME to scope Calendar.app.",
        status: "info"
      });
      expect(snapshot.messaging).toEqual({
        nextStep: "Remote messaging setup is disabled while MUSE_LOCAL_ONLY=true; local log/native notifications remain available.",
        providers: [],
        status: "info"
      });
    } finally {
      if (previous === undefined) delete process.env.MUSE_LOCAL_ONLY; else process.env.MUSE_LOCAL_ONLY = previous;
      if (previousKeys === undefined) delete process.env.MUSE_MODEL_KEYS_FILE; else process.env.MUSE_MODEL_KEYS_FILE = previousKeys;
      if (previousCalendar === undefined) delete process.env.MUSE_CALENDAR_FILE; else process.env.MUSE_CALENDAR_FILE = previousCalendar;
      if (previousMessaging === undefined) delete process.env.MUSE_MESSAGING_CREDENTIALS_FILE; else process.env.MUSE_MESSAGING_CREDENTIALS_FILE = previousMessaging;
      await fs.rm(root, { force: true, recursive: true });
    }
  });
});

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

  it("refuses remote Home Assistant under local-only before any bearer-token reflection", () => {
    const counts = { get: 0, getOwnPropertyDescriptor: 0, has: 0, ownKeys: 0 };
    const env = new Proxy({
      MUSE_HOMEASSISTANT_URL: "http://ha.local:8123",
      MUSE_LOCAL_ONLY: "true"
    } as Record<string, string | undefined>, {
      get(target, property, receiver) {
        if (property === "MUSE_HOMEASSISTANT_TOKEN") {
          counts.get += 1;
          throw new Error("token getter must remain untouched");
        }
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "MUSE_HOMEASSISTANT_TOKEN") {
          counts.getOwnPropertyDescriptor += 1;
          throw new Error("token descriptor must remain untouched");
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      has(target, property) {
        if (property === "MUSE_HOMEASSISTANT_TOKEN") {
          counts.has += 1;
          throw new Error("token presence must remain untouched");
        }
        return Reflect.has(target, property);
      },
      ownKeys(target) {
        counts.ownKeys += 1;
        return Reflect.ownKeys(target);
      }
    });
    const status = readActuatorReadiness(env);
    expect(status).toMatchObject({
      home: false,
      homeReason: "Home Assistant remote paths are disabled while MUSE_LOCAL_ONLY=true; canonical loopback remains available"
    });
    expect(status.nextStep).toContain("canonical loopback remains available");
    expect(counts).toEqual({ get: 0, getOwnPropertyDescriptor: 0, has: 0, ownKeys: 0 });
  });
});

describe.sequential("T2-B2b Home Assistant setup-status snapshot containment", () => {
  const previousLocalOnly = process.env.MUSE_LOCAL_ONLY;

  afterEach(() => {
    if (previousLocalOnly === undefined) delete process.env.MUSE_LOCAL_ONLY;
    else process.env.MUSE_LOCAL_ONLY = previousLocalOnly;
  });

  it("keeps a remote token hidden when ambient strictness overrides a frozen false API snapshot", async () => {
    process.env.MUSE_LOCAL_ONLY = "true";
    const counts = { get: 0, getOwnPropertyDescriptor: 0, has: 0, ownKeys: 0 };
    const env = new Proxy({
      HOME: tmpdir(),
      MUSE_HOMEASSISTANT_URL: "http://ha.local:8123",
      MUSE_LOCAL_ONLY: "false",
      MUSE_MODEL_KEYS_FILE: "/tmp/muse-status-missing-models.json"
    } as Record<string, string | undefined>, {
      get(target, property, receiver) {
        if (property === "MUSE_HOMEASSISTANT_TOKEN") {
          counts.get += 1;
          throw new Error("token getter must remain untouched");
        }
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "MUSE_HOMEASSISTANT_TOKEN") {
          counts.getOwnPropertyDescriptor += 1;
          throw new Error("token descriptor must remain untouched");
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      has(target, property) {
        if (property === "MUSE_HOMEASSISTANT_TOKEN") {
          counts.has += 1;
          throw new Error("token presence must remain untouched");
        }
        return Reflect.has(target, property);
      },
      ownKeys(target) {
        counts.ownKeys += 1;
        return Reflect.ownKeys(target);
      }
    });
    const snapshot = await collectSetupStatusJson({
      env,
      integrationEnv: resolveIntegrationEnvironment({ HOME: tmpdir(), MUSE_LOCAL_ONLY: "false" })
    });
    expect(snapshot).toMatchObject({
      actuators: { home: false },
      localOnly: { enabled: true }
    });
    expect(snapshot.actuators.nextStep).toContain("canonical loopback remains available");
    expect(counts).toEqual({ get: 0, getOwnPropertyDescriptor: 0, has: 0, ownKeys: 0 });
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
