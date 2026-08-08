import { MessagingProviderRegistry } from "@muse/messaging";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProactiveRuntimeStatusStore } from "../src/proactive-runtime-status.js";
import { startProactiveDaemonIfConfigured } from "../src/tick-daemons.js";
import type { ServerOptions } from "../src/server.js";

function fakeServer() {
  const hooks: { readonly name: string; readonly fn: () => unknown }[] = [];
  return {
    hooks,
    server: {
      addHook: (name: string, fn: () => unknown) => hooks.push({ fn, name }),
      log: { info: () => undefined, warn: () => undefined }
    }
  };
}

function configuredOptions(): ServerOptions {
  return {
    messaging: new MessagingProviderRegistry(),
    tasksFile: "/tmp/muse-proactive-runtime-status-tasks.json"
  } as unknown as ServerOptions;
}

const phaseD = { phaseDProactiveOn: false, phaseDReminderOn: false };

afterEach(() => {
  vi.useRealTimers();
});

describe("startProactiveDaemonIfConfigured runtime lifecycle", () => {
  it("records configured startup as dormant before the first interval", () => {
    const { hooks, server } = fakeServer();
    const runtimeStatus = createProactiveRuntimeStatusStore();

    startProactiveDaemonIfConfigured({}, server as never, configuredOptions(), phaseD, runtimeStatus);

    expect(hooks.filter((hook) => hook.name === "onClose")).toHaveLength(1);
    expect(runtimeStatus.get()).toMatchObject({ availability: "dormant", lastDecision: "startup", phase: "startup" });
    hooks.find((hook) => hook.name === "onClose")?.fn();
  });

  it("records missing messaging or signal as not-configured without creating a timer", () => {
    const { hooks, server } = fakeServer();
    const runtimeStatus = createProactiveRuntimeStatusStore();

    startProactiveDaemonIfConfigured({}, server as never, { messaging: undefined } as unknown as ServerOptions, phaseD, runtimeStatus);

    expect(hooks).toHaveLength(0);
    expect(runtimeStatus.get()).toMatchObject({ availability: "not-configured", lastDecision: "startup", phase: "startup" });
  });

  it("records missing signal as not-configured when messaging is defined", () => {
    vi.useFakeTimers();
    const { hooks, server } = fakeServer();
    const runtimeStatus = createProactiveRuntimeStatusStore();
    const options = {
      messaging: new MessagingProviderRegistry()
    } as unknown as ServerOptions;

    startProactiveDaemonIfConfigured({}, server as never, options, phaseD, runtimeStatus);

    expect(hooks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(runtimeStatus.get()).toMatchObject({ availability: "not-configured", lastDecision: "startup", phase: "startup" });
  });

  it("records a delivery-brake block without creating a timer or close hook", () => {
    const { hooks, server } = fakeServer();
    const runtimeStatus = createProactiveRuntimeStatusStore();

    startProactiveDaemonIfConfigured({}, server as never, configuredOptions(), phaseD, runtimeStatus, true);

    expect(hooks).toHaveLength(0);
    expect(runtimeStatus.get()).toMatchObject({ availability: "blocked", lastDecision: "startup", phase: "startup" });
  });
});
