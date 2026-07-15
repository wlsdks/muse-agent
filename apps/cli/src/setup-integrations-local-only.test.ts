import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCalendarSetup } from "./setup-calendar.js";
import { runMessagingSetup } from "./setup-messaging.js";

const ENV_KEYS = ["MUSE_LOCAL_ONLY"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  vi.doUnmock("./setup-model.js");
  vi.resetModules();
});

describe("T2-B1 setup integration local-only gates", () => {
  it("returns before calendar/messaging wizard storage or prompt setup with an injected local-only env", async () => {
    const calendar: string[] = [];
    const messaging: string[] = [];
    await runCalendarSetup({
      env: { MUSE_LOCAL_ONLY: "true" },
      home: "/path-that-must-not-be-read",
      stderr: () => {},
      stdout: (message) => calendar.push(message)
    });
    await runMessagingSetup({
      env: { MUSE_LOCAL_ONLY: "true" },
      home: "/path-that-must-not-be-read",
      stderr: () => {},
      stdout: (message) => messaging.push(message)
    });

    expect(calendar.join("")).toContain("Remote Google/CalDAV setup is disabled while MUSE_LOCAL_ONLY=true");
    expect(calendar.join("")).toContain("MUSE_LOCAL_ONLY=false");
    expect(messaging.join("")).toContain("Remote bot setup is disabled while MUSE_LOCAL_ONLY=true");
    expect(messaging.join("")).toContain("Local log/native notifications");
  });

  it("real registered setup commands inherit process.env when no env seam is supplied", async () => {
    process.env.MUSE_LOCAL_ONLY = "true";
    const output: string[] = [];
    const { registerSetupCommands } = await import("./commands-scheduler-setup.js");
    const program = new Command();
    program.exitOverride();
    registerSetupCommands(program, { stderr: () => {}, stdout: (message) => output.push(message) });

    await program.parseAsync(["node", "muse", "setup", "calendar"], { from: "node" });
    await program.parseAsync(["node", "muse", "setup", "messaging"], { from: "node" });

    const joined = output.join("");
    expect(joined).toContain("Remote Google/CalDAV setup is disabled while MUSE_LOCAL_ONLY=true");
    expect(joined).toContain("Remote bot setup is disabled while MUSE_LOCAL_ONLY=true");
  }, 30_000);

  it("the real setup wizard reaches the same process-env gates after its model step", async () => {
    process.env.MUSE_LOCAL_ONLY = "true";
    vi.resetModules();
    vi.doMock("./setup-model.js", () => ({
      SETUP_MODEL_PROVIDER_SPECS: [],
      runModelSetup: async (io: { stdout(message: string): void }) => { io.stdout("model step\\n"); }
    }));
    const { runSetupWizard } = await import("./commands-scheduler-setup.js");
    const output: string[] = [];
    await runSetupWizard({ stderr: () => {}, stdout: (message) => output.push(message) });

    const joined = output.join("");
    expect(joined).toContain("model step");
    expect(joined).toContain("Remote Google/CalDAV setup is disabled while MUSE_LOCAL_ONLY=true");
    expect(joined).toContain("Remote bot setup is disabled while MUSE_LOCAL_ONLY=true");
  });
});
