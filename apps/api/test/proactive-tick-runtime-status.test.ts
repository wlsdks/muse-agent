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
    expect(runtimeStatus.get()?.lastDecision).toBe(expectedDecision);
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
});
