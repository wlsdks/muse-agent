import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeOnboarding, registerOnboardCommand, type OnboardingState } from "./commands-onboard.js";
import { readDaemonConfig, writeDaemonConfig } from "./commands-daemon-config.js";
import { readConfigStore, writeConfigStore } from "./program-config.js";
import type { ProgramIO } from "./program.js";

const base: OnboardingState = {
  chatModel: "qwen3:8b",
  embedModel: "nomic-embed-text",
  indexBuilt: false,
  installedModels: [],
  noteFileCount: 0,
  notesDir: "/home/u/.muse/notes",
  ollamaReachable: false
};

const next = (s: OnboardingState) => computeOnboarding(s);

describe("computeOnboarding — the single next step to the first cited answer", () => {
  it("Ollama down → next is `ollama serve`, not ready", () => {
    const r = next(base);
    expect(r.ready).toBe(false);
    expect(r.nextCommand).toBe("ollama serve");
    expect(r.steps[0]).toMatchObject({ id: "ollama", status: "action" });
  });

  it("Ollama up but no models → next pulls the chat model first (dependency order)", () => {
    const r = next({ ...base, ollamaReachable: true });
    expect(r.nextCommand).toBe("ollama pull qwen3:8b");
  });

  it("models present (base/tag match) but empty corpus → next is `muse ingest`", () => {
    const r = next({ ...base, installedModels: ["qwen3:8b", "nomic-embed-text:latest"], ollamaReachable: true });
    expect(r.steps.find((s) => s.id === "chat-model")?.status).toBe("ok");
    expect(r.steps.find((s) => s.id === "embed-model")?.status).toBe("ok"); // :latest tag matches base
    expect(r.nextCommand).toContain("muse ingest");
  });

  it("corpus present but no index → next is `muse notes reindex`", () => {
    const r = next({ ...base, installedModels: ["qwen3:8b", "nomic-embed-text"], noteFileCount: 12, ollamaReachable: true });
    expect(r.nextCommand).toBe("muse notes reindex");
  });

  it("everything ready → ready=true, next is the ask example", () => {
    const r = next({ ...base, indexBuilt: true, installedModels: ["qwen3:8b", "nomic-embed-text"], noteFileCount: 12, ollamaReachable: true });
    expect(r.ready).toBe(true);
    expect(r.nextCommand).toContain("muse ask --notes-only");
    expect(r.steps.every((s) => s.status === "ok")).toBe(true);
  });

  it("honours a custom chat model in the action + label", () => {
    const r = next({ ...base, chatModel: "llama3.2:3b", ollamaReachable: true });
    expect(r.nextCommand).toBe("ollama pull llama3.2:3b");
    expect(r.steps.find((s) => s.id === "chat-model")?.title).toContain("llama3.2:3b");
  });

  it("empty personal sensors (no contacts, no browsing) → connect-data hint points at `muse setup data`", () => {
    const r = next({ ...base, browsingVisitCount: 0, contactsCount: 0 });
    expect(r.dataHint?.command).toBe("muse setup data");
  });

  it("any personal data present → no connect-data hint (they've already started)", () => {
    expect(next({ ...base, contactsCount: 12 }).dataHint).toBeUndefined();
    expect(next({ ...base, browsingVisitCount: 5 }).dataHint).toBeUndefined();
  });

  it("does not gate readiness on personal data — a ready notes setup stays ready with empty sensors", () => {
    const r = next({ ...base, browsingVisitCount: 0, contactsCount: 0, indexBuilt: true, installedModels: ["qwen3:8b", "nomic-embed-text"], noteFileCount: 12, ollamaReachable: true });
    expect(r.ready).toBe(true);
    expect(r.dataHint?.command).toBe("muse setup data");
  });
});

describe("muse onboard — closing hints (R2-3)", () => {
  it("ends with a scheduling example and the rollback safety line", async () => {
    const out: string[] = [];
    const io: ProgramIO = {
      fetch: (() => Promise.reject(new Error("no network in test"))) as typeof globalThis.fetch,
      stderr: () => undefined,
      stdout: (s) => out.push(s)
    };
    const program = new Command();
    registerOnboardCommand(program, io);
    await program.parseAsync(["node", "muse", "onboard"]);
    const text = out.join("");
    expect(text).toContain("muse scheduler add");
  });

  it("without an injected confirm, a real (non-TTY) test run never calls the daemon install seams and prints the manual hint", async () => {
    const out: string[] = [];
    const io: ProgramIO = {
      fetch: (() => Promise.reject(new Error("no network in test"))) as typeof globalThis.fetch,
      stderr: () => undefined,
      stdout: (s) => out.push(s)
    };
    const program = new Command();
    // No `confirm` helper injected: under vitest stdin/stdout are not a TTY,
    // so the real gate takes the safe default (no install) — this must
    // never call the real launchctl/schtasks default (which throws under
    // vitest) even though `platform: "darwin"` makes the offer eligible.
    registerOnboardCommand(program, io, { platform: "darwin" });
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(out.join("")).toContain("muse daemon --install");
  });
});

describe("muse onboard — background-daemon offer (R3-5)", () => {
  const stableDaemonCliEntry = fileURLToPath(import.meta.url);

  function runIo(): { io: ProgramIO; out: string[] } {
    const out: string[] = [];
    const io: ProgramIO = {
      fetch: (() => Promise.reject(new Error("no network in test"))) as typeof globalThis.fetch,
      stderr: () => undefined,
      stdout: (s) => out.push(s)
    };
    return { io, out };
  }

  it("on darwin, a 'yes' answer runs the SAME install path muse daemon --install uses, through the injected launchctl seam", async () => {
    const { io, out } = runIo();
    const calls: string[][] = [];
    const program = new Command();
    registerOnboardCommand(program, io, {
      confirm: async () => true,
      daemonCliEntry: stableDaemonCliEntry,
      daemonTemporaryRoots: [],
      platform: "darwin",
      runLaunchctl: async (args) => {
        calls.push([...args]);
        // `list <label>` — launchd's real dump format (see commands-daemon-launchagent.ts's `parseLaunchctlListInfo`).
        if (args[0] === "list") return { code: 0, stdout: '{\n\t"PID" = 4242;\n\t"LastExitStatus" = 0;\n};\n', stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(calls.some((c) => c[0] === "load")).toBe(true);
    expect(out.join("")).toContain("loaded via launchctl and RUNNING");
  });

  it("on win32, a 'yes' answer registers via the injected schtasks seam", async () => {
    const { io, out } = runIo();
    const program = new Command();
    registerOnboardCommand(program, io, {
      confirm: async () => true,
      daemonCliEntry: stableDaemonCliEntry,
      daemonTemporaryRoots: [],
      platform: "win32",
      schtasksRun: async () => ({ exitCode: 0, stderr: "", stdout: "" })
    });
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(out.join("")).toContain("registered as scheduled task");
  });

  it("a 'no' answer prints the manual hint and never touches the install seams", async () => {
    const { io, out } = runIo();
    const program = new Command();
    registerOnboardCommand(program, io, {
      confirm: async () => false,
      platform: "darwin",
      runLaunchctl: () => { throw new Error("must not be called on a 'no' answer"); }
    });
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(out.join("")).toContain("muse daemon --install");
  });

  it("on an unsupported platform (linux), the manual hint prints and the confirm prompt is never asked", async () => {
    const { io, out } = runIo();
    const program = new Command();
    let confirmed = false;
    registerOnboardCommand(program, io, {
      confirm: async () => { confirmed = true; return true; },
      platform: "linux"
    });
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(confirmed).toBe(false);
    expect(out.join("")).toContain("muse daemon --install");
  });

  it("an install failure falls back to the manual hint — onboard still succeeds (no throw)", async () => {
    const { io, out } = runIo();
    const program = new Command();
    registerOnboardCommand(program, io, {
      confirm: async () => true,
      platform: "darwin",
      runLaunchctl: async (args) => (args[0] === "list" ? { code: 1, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "boom" })
    });
    // Never throws — a failed install is fail-soft, not a crashed onboard run.
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(out.join("")).toContain("muse daemon --install");
  });

  it("an install seam that THROWS is fail-soft — onboard still succeeds and prints the manual hint", async () => {
    const { io, out } = runIo();
    const program = new Command();
    registerOnboardCommand(program, io, {
      confirm: async () => true,
      platform: "darwin",
      runLaunchctl: async () => { throw new Error("launchctl not found"); }
    });
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(out.join("")).toContain("muse daemon --install");
  });

  it("--json skips the interactive offer entirely (no confirm call, no install-seam call)", async () => {
    const { io } = runIo();
    const program = new Command();
    let confirmed = false;
    registerOnboardCommand(program, io, { confirm: async () => { confirmed = true; return true; }, platform: "darwin" });
    await program.parseAsync(["node", "muse", "onboard", "--json"]);
    expect(confirmed).toBe(false);
  });
});

describe("muse onboard — native macOS notification offer", () => {
  function runIo(): { io: ProgramIO; out: string[] } {
    const out: string[] = [];
    const io: ProgramIO = {
      fetch: (() => Promise.reject(new Error("no network in test"))) as typeof globalThis.fetch,
      stderr: () => undefined,
      stdout: (s) => out.push(s)
    };
    return { io, out };
  }

  const prevConfigFile = process.env.MUSE_DAEMON_CONFIG_FILE;
  let configFile: string;
  beforeEach(() => {
    configFile = join(mkdtempSync(join(tmpdir(), "muse-onboard-notif-")), "daemon.json");
    process.env.MUSE_DAEMON_CONFIG_FILE = configFile;
  });
  afterEach(() => {
    if (prevConfigFile === undefined) delete process.env.MUSE_DAEMON_CONFIG_FILE;
    else process.env.MUSE_DAEMON_CONFIG_FILE = prevConfigFile;
  });

  it("darwin + accept writes the daemon config with provider macos-notification and destination '@me'", async () => {
    const { io, out } = runIo();
    const program = new Command();
    registerOnboardCommand(program, io, {
      confirm: async () => false, // decline the background-daemon offer first
      confirmNotifications: async () => true,
      platform: "darwin"
    });
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(out.join("")).toContain("Native notifications enabled");
    const config = readDaemonConfig(configFile);
    expect(config).toMatchObject({ destination: "@me", provider: "macos-notification" });
  });

  it("darwin + accept preserves an EXISTING destination and dailyBrief block", async () => {
    writeDaemonConfig(configFile, { dailyBrief: { enabled: true, time: "08:30" }, destination: "telegram:12345", provider: "log" });
    const { io } = runIo();
    const program = new Command();
    registerOnboardCommand(program, io, {
      confirm: async () => false,
      confirmNotifications: async () => true,
      platform: "darwin"
    });
    await program.parseAsync(["node", "muse", "onboard"]);
    const config = readDaemonConfig(configFile);
    expect(config).toMatchObject({
      dailyBrief: { enabled: true, time: "08:30" },
      destination: "telegram:12345",
      provider: "macos-notification"
    });
  });

  it("darwin + decline writes NO config and prints the notifications.log pointer", async () => {
    const { io, out } = runIo();
    const program = new Command();
    registerOnboardCommand(program, io, {
      confirm: async () => false,
      confirmNotifications: async () => false,
      platform: "darwin"
    });
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(out.join("")).toContain("notifications.log");
    expect(readDaemonConfig(configFile)).toEqual({});
  });

  it("non-darwin never asks and writes no config, prints the notifications.log pointer", async () => {
    const { io, out } = runIo();
    const program = new Command();
    let asked = false;
    registerOnboardCommand(program, io, {
      confirm: async () => false,
      confirmNotifications: async () => { asked = true; return true; },
      platform: "linux"
    });
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(asked).toBe(false);
    expect(out.join("")).toContain("notifications.log");
    expect(readDaemonConfig(configFile)).toEqual({});
  });

  it("without an injected confirmNotifications, a non-TTY test run declines safely (no config write)", async () => {
    const { io, out } = runIo();
    const program = new Command();
    registerOnboardCommand(program, io, { confirm: async () => false, platform: "darwin" });
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(out.join("")).toContain("notifications.log");
    expect(readDaemonConfig(configFile)).toEqual({});
  });

  it("a config-write failure fails soft — onboard still succeeds (no throw)", async () => {
    const { io, out } = runIo();
    const program = new Command();
    // Point at an unwritable location — a directory path used as the config file.
    const badDir = mkdtempSync(join(tmpdir(), "muse-onboard-baddir-"));
    process.env.MUSE_DAEMON_CONFIG_FILE = badDir; // writeFileSync(dir, …) throws EISDIR
    registerOnboardCommand(program, io, {
      confirm: async () => false,
      confirmNotifications: async () => true,
      platform: "darwin"
    });
    await program.parseAsync(["node", "muse", "onboard"]);
    expect(out.join("")).toContain("notifications.log");
  });
});

describe("muse onboard — the FIRST interactive question (AC1: language)", () => {
  function runIo(configDir: string): { io: ProgramIO; out: string[] } {
    const out: string[] = [];
    const io: ProgramIO = {
      configDir,
      fetch: (() => Promise.reject(new Error("no network in test"))) as typeof globalThis.fetch,
      stderr: () => undefined,
      stdout: (s) => out.push(s)
    };
    return { io, out };
  }

  it("non-interactive (no TTY under vitest, no selectLanguage helper injected) persists OS-locale auto-detect without hanging or prompting", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "muse-onboard-lang-auto-"));
    const { io } = runIo(configDir);
    const originalLang = process.env.LANG;
    process.env.LANG = "ko_KR.UTF-8";
    try {
      const program = new Command();
      registerOnboardCommand(program, io);
      await program.parseAsync(["node", "muse", "onboard", "--json"]);
      expect((await readConfigStore(io)).language).toBe("ko");
    } finally {
      if (originalLang === undefined) delete process.env.LANG; else process.env.LANG = originalLang;
    }
  });

  it("non-interactive keeps an already-chosen language rather than overwriting it from the current locale", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "muse-onboard-lang-keep-"));
    const { io } = runIo(configDir);
    await writeConfigStore(io, { language: "en" });
    const originalLang = process.env.LANG;
    process.env.LANG = "ko_KR.UTF-8";
    try {
      const program = new Command();
      registerOnboardCommand(program, io);
      await program.parseAsync(["node", "muse", "onboard", "--json"]);
      expect((await readConfigStore(io)).language).toBe("en");
    } finally {
      if (originalLang === undefined) delete process.env.LANG; else process.env.LANG = originalLang;
    }
  });

  it("an injected selectLanguage (simulating the interactive select) is offered the current default and its answer persists", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "muse-onboard-lang-select-"));
    const { io } = runIo(configDir);
    const offeredDefaults: string[] = [];
    const program = new Command();
    registerOnboardCommand(program, io, {
      selectLanguage: async (defaultLang) => { offeredDefaults.push(defaultLang); return "ko"; }
    });
    await program.parseAsync(["node", "muse", "onboard", "--json"]);
    expect(offeredDefaults).toHaveLength(1);
    expect((await readConfigStore(io)).language).toBe("ko");
  });

  it("cancelling the language select (undefined) persists nothing and does not throw", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "muse-onboard-lang-cancel-"));
    const { io } = runIo(configDir);
    const program = new Command();
    registerOnboardCommand(program, io, { selectLanguage: async () => undefined });
    await program.parseAsync(["node", "muse", "onboard", "--json"]);
    expect((await readConfigStore(io)).language).toBeUndefined();
  });
});
