import { describe, expect, it, vi } from "vitest";

const mockedProactivity = vi.hoisted(() => ({ runDueProactiveNotices: vi.fn() }));

vi.mock("@muse/proactivity", async () => ({
  ...(await vi.importActual<typeof import("@muse/proactivity")>("@muse/proactivity")),
  runDueProactiveNotices: mockedProactivity.runDueProactiveNotices
}));

import type { MessagingProviderRegistry } from "@muse/messaging";
import type { RunDueProactiveNoticesSummary } from "@muse/proactivity";

import { createProactiveRuntimeStatusStore } from "../src/proactive-runtime-status.js";
import { startProactiveTick } from "../src/proactive-tick.js";

const NOW = new Date("2026-08-08T01:02:03.000Z");

function summary(overrides: Partial<RunDueProactiveNoticesSummary> = {}): RunDueProactiveNoticesSummary {
  return { errors: [], fired: 0, imminent: 0, ...overrides };
}

async function observe(
  expectedDecision: string,
  result: RunDueProactiveNoticesSummary,
  options: { readonly quietHours?: { readonly endHour: number; readonly startHour: number }; readonly route?: boolean } = {}
): Promise<void> {
  mockedProactivity.runDueProactiveNotices.mockReset();
  if (!options.quietHours && options.route !== false) {
    mockedProactivity.runDueProactiveNotices.mockResolvedValueOnce(result);
  }
  const runtimeStatus = createProactiveRuntimeStatusStore();
  const handle = startProactiveTick({
    destination: "owner",
    messagingRegistry: {} as MessagingProviderRegistry,
    now: () => NOW,
    ...(options.quietHours ? { quietHours: options.quietHours } : {}),
    ...(options.route === false ? {} : { providerId: "log" }),
    runtimeStatus,
    sidecarFile: "/tmp/muse-proactive-runtime-status.json"
  });
  try {
      await handle.tickOnce();
      expect(runtimeStatus.get()).toMatchObject({ availability: "observed", lastDecision: expectedDecision, phase: "tick" });
  } finally {
    handle.stop();
  }
}

describe("startProactiveTick runtime status classification", () => {
  it.each([
    ["quiet-hours", summary(), { quietHours: { endHour: 23, startHour: 0 } }],
    ["route-unavailable", summary(), { route: false }],
    ["session-locked", summary({ sessionLockedUntil: "2026-08-08T01:12:03.000Z" }), {}],
    ["lock-held", summary({ outcome: "lock-held" }), {}],
    ["lock-error", summary({ errors: ["raw lock failure"], outcome: "lock-error" }), {}],
    ["no-imminent", summary(), {}],
    ["suppressed", summary({ imminent: 1, suppressions: [{ itemId: "task-1", kind: "task", reason: "permission-denied" }] }), {}],
    ["fired", summary({ fired: 1, imminent: 1 }), {}],
    ["completed", summary({ imminent: 1 }), {}],
    ["error", summary({ errors: ["raw delivery failure"], fired: 1, imminent: 1 }), {}]
  ] as const)("records %s", async (decision, result, options) => {
    await observe(decision, result, options);
  });

  it("records an outer invocation as already-running without starting a second delivery", async () => {
    mockedProactivity.runDueProactiveNotices.mockReset();
    let release!: (result: RunDueProactiveNoticesSummary) => void;
    mockedProactivity.runDueProactiveNotices.mockReturnValueOnce(new Promise<RunDueProactiveNoticesSummary>((resolve) => {
      release = resolve;
    }));
    const runtimeStatus = createProactiveRuntimeStatusStore();
    const handle = startProactiveTick({
      destination: "owner",
      messagingRegistry: {} as MessagingProviderRegistry,
      now: () => NOW,
      providerId: "log",
      runtimeStatus,
      sidecarFile: "/tmp/muse-proactive-runtime-status-concurrent.json"
    });

    try {
      const first = handle.tickOnce();
      await handle.tickOnce();
      expect(runtimeStatus.get()?.lastDecision).toBe("already-running");
      expect(mockedProactivity.runDueProactiveNotices).toHaveBeenCalledTimes(1);
      release(summary());
      await first;
    } finally {
      handle.stop();
    }
  });

  it("records thrown tick failures as error without exposing the thrown message", async () => {
    mockedProactivity.runDueProactiveNotices.mockRejectedValueOnce(new Error("secret delivery detail"));
    const runtimeStatus = createProactiveRuntimeStatusStore();
    const handle = startProactiveTick({
      destination: "owner",
      errorLogger: vi.fn(),
      messagingRegistry: {} as MessagingProviderRegistry,
      now: () => NOW,
      providerId: "log",
      runtimeStatus,
      sidecarFile: "/tmp/muse-proactive-runtime-status-error.json"
    });
    try {
      await handle.tickOnce();
      expect(runtimeStatus.get()).toMatchObject({ lastDecision: "error", lastErrorCount: 1 });
      expect(JSON.stringify(runtimeStatus.get())).not.toContain("secret delivery detail");
    } finally {
      handle.stop();
    }
  });

  it("fails closed on a route resolver throw without calling delivery or logging the raw error", async () => {
    mockedProactivity.runDueProactiveNotices.mockReset();
    const errorLogger = vi.fn();
    const runtimeStatus = createProactiveRuntimeStatusStore();
    const handle = startProactiveTick({
      errorLogger,
      messagingRegistry: {} as MessagingProviderRegistry,
      now: () => NOW,
      resolveRoute: () => { throw new Error("secret route detail"); },
      runtimeStatus,
      sidecarFile: "/tmp/muse-proactive-runtime-status-route-throw.json"
    });
    try {
      await handle.tickOnce();
      expect(mockedProactivity.runDueProactiveNotices).not.toHaveBeenCalled();
      expect(errorLogger).not.toHaveBeenCalled();
      expect(runtimeStatus.get()?.lastDecision).toBe("route-unavailable");
      expect(runtimeStatus.get()?.lastRoute).toEqual({
        destination: null,
        localOnly: false,
        providerId: null,
        reason: "paired-route-inspection-unavailable",
        source: null,
        status: "unconfigured"
      });
      expect(JSON.stringify(runtimeStatus.get())).not.toContain("secret route detail");
    } finally {
      handle.stop();
    }
  });

  it("does not treat an incomplete resolved receipt as sendable", async () => {
    mockedProactivity.runDueProactiveNotices.mockReset();
    const runtimeStatus = createProactiveRuntimeStatusStore();
    const handle = startProactiveTick({
      messagingRegistry: {} as MessagingProviderRegistry,
      now: () => NOW,
      resolveRoute: () => ({
        destination: null,
        localOnly: false,
        providerId: null,
        reason: null,
        source: "explicit-config",
        status: "resolved"
      }),
      runtimeStatus,
      sidecarFile: "/tmp/muse-proactive-runtime-status-route-incomplete.json"
    });
    try {
      await handle.tickOnce();
      expect(mockedProactivity.runDueProactiveNotices).not.toHaveBeenCalled();
      expect(runtimeStatus.get()?.lastRoute).toEqual({
        destination: null,
        localOnly: false,
        providerId: null,
        reason: null,
        source: "explicit-config",
        status: "resolved"
      });
    } finally {
      handle.stop();
    }
  });

  it("records local-only blocking without entering the delivery path", async () => {
    mockedProactivity.runDueProactiveNotices.mockReset();
    const runtimeStatus = createProactiveRuntimeStatusStore();
    const handle = startProactiveTick({
      messagingRegistry: {} as MessagingProviderRegistry,
      now: () => NOW,
      resolveRoute: () => ({
        destination: "owner",
        localOnly: true,
        providerId: "telegram",
        reason: "remote-route-blocked-by-local-only",
        source: "explicit-config",
        status: "blocked-local-only"
      }),
      runtimeStatus,
      sidecarFile: "/tmp/muse-proactive-runtime-status-local-only.json"
    });
    try {
      await handle.tickOnce();
      expect(mockedProactivity.runDueProactiveNotices).not.toHaveBeenCalled();
      expect(runtimeStatus.get()?.lastRoute.status).toBe("blocked-local-only");
    } finally {
      handle.stop();
    }
  });

  it("preserves the last execution route through a quiet skip and replaces it on re-entry", async () => {
    mockedProactivity.runDueProactiveNotices.mockReset();
    mockedProactivity.runDueProactiveNotices.mockResolvedValue(summary({ imminent: 1, fired: 1 }));
    let route = {
      destination: "owner-a",
      localOnly: false,
      providerId: "telegram",
      reason: null,
      source: "explicit-config" as const,
      status: "resolved" as const
    };
    let quiet = false;
    const runtimeStatus = createProactiveRuntimeStatusStore();
    const handle = startProactiveTick({
      messagingRegistry: {} as MessagingProviderRegistry,
      now: () => NOW,
      quietHours: () => quiet ? { endHour: 23, startHour: 0 } : undefined,
      resolveRoute: () => route,
      runtimeStatus,
      sidecarFile: "/tmp/muse-proactive-runtime-status-route-reentry.json"
    });
    try {
      await handle.tickOnce();
      expect(runtimeStatus.get()?.lastRoute.destination).toBe("owner-a");
      quiet = true;
      await handle.tickOnce();
      expect(runtimeStatus.get()?.lastRoute.destination).toBe("owner-a");
      quiet = false;
      route = { ...route, destination: "owner-b" };
      await handle.tickOnce();
      expect(runtimeStatus.get()?.lastRoute.destination).toBe("owner-b");
    } finally {
      handle.stop();
    }
  });

  it("does not let a runtime receipt failure alter delivery", async () => {
    mockedProactivity.runDueProactiveNotices.mockReset();
    mockedProactivity.runDueProactiveNotices.mockResolvedValue(summary());
    const handle = startProactiveTick({
      destination: "owner",
      messagingRegistry: {} as MessagingProviderRegistry,
      now: () => NOW,
      providerId: "log",
      runtimeStatus: { get: () => null, record: () => { throw new Error("status store failure"); } },
      sidecarFile: "/tmp/muse-proactive-runtime-status-store-throw.json"
    });
    try {
      await expect(handle.tickOnce()).resolves.toBeUndefined();
      expect(mockedProactivity.runDueProactiveNotices).toHaveBeenCalledTimes(1);
    } finally {
      handle.stop();
    }
  });

  it("keeps the exact attempted route when delivery work throws", async () => {
    mockedProactivity.runDueProactiveNotices.mockReset();
    mockedProactivity.runDueProactiveNotices.mockRejectedValueOnce(new Error("secret provider detail"));
    const runtimeStatus = createProactiveRuntimeStatusStore();
    const handle = startProactiveTick({
      destination: "owner-a",
      errorLogger: vi.fn(),
      messagingRegistry: {} as MessagingProviderRegistry,
      now: () => NOW,
      providerId: "log",
      runtimeStatus,
      sidecarFile: "/tmp/muse-proactive-runtime-status-provider-throw.json"
    });
    try {
      await handle.tickOnce();
      expect(runtimeStatus.get()?.lastDecision).toBe("error");
      expect(runtimeStatus.get()?.lastRoute).toEqual({
        destination: "owner-a",
        localOnly: false,
        providerId: "log",
        reason: null,
        source: "explicit-config",
        status: "resolved"
      });
      expect(JSON.stringify(runtimeStatus.get())).not.toContain("secret provider detail");
    } finally {
      handle.stop();
    }
  });
});
