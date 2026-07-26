import { MessagingProviderRegistry } from "@muse/messaging";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerOptions } from "./server-options.js";

const mocks = vi.hoisted(() => ({
  createActivityTracker: vi.fn(() => ({ record: vi.fn() })),
  createInboundAgentRun: vi.fn(),
  startAmbient: vi.fn(),
  startBriefing: vi.fn(),
  startConsolidate: vi.fn(),
  startDigest: vi.fn(),
  startFollowup: vi.fn(),
  startHomeWatch: vi.fn(),
  startObjectives: vi.fn(),
  startPattern: vi.fn(),
  startProactive: vi.fn(),
  startReminder: vi.fn(),
  startWebWatch: vi.fn()
}));

vi.mock("./proactive-tick.js", () => ({
  createFileBackedActivityTracker: mocks.createActivityTracker,
  createInMemoryActivityTracker: mocks.createActivityTracker
}));

vi.mock("./inbound-agent-run.js", () => ({
  createInboundAgentRun: mocks.createInboundAgentRun
}));

vi.mock("./tick-daemons.js", () => ({
  startAmbientDaemonIfConfigured: mocks.startAmbient,
  startConsolidateDaemonIfConfigured: mocks.startConsolidate,
  startDigestDaemonIfConfigured: mocks.startDigest,
  startFollowupDaemonIfConfigured: mocks.startFollowup,
  startHomeWatchDaemonIfConfigured: mocks.startHomeWatch,
  startObjectivesDaemonIfConfigured: mocks.startObjectives,
  startPatternDaemonIfConfigured: mocks.startPattern,
  startProactiveDaemonIfConfigured: mocks.startProactive,
  startReminderDaemonIfConfigured: mocks.startReminder,
  startSituationalBriefingDaemonIfConfigured: mocks.startBriefing,
  startWebWatchDaemonIfConfigured: mocks.startWebWatch
}));

import { buildServer } from "./server.js";

const outboundStarters = [
  mocks.startAmbient,
  mocks.startBriefing,
  mocks.startDigest,
  mocks.startFollowup,
  mocks.startHomeWatch,
  mocks.startObjectives,
  mocks.startPattern,
  mocks.startProactive,
  mocks.startReminder,
  mocks.startWebWatch
] as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe("API delivery brake construction boundary", () => {
  it.each(["false", "malformed"])(
    "does not construct outbound daemon, activity, or channel-reply paths when delivery is %s",
    async (delivery) => {
      const server = buildServer({
        agentRuntime: {} as ServerOptions["agentRuntime"],
        defaultModel: "test-model",
        env: {
          HOME: "/tmp/muse-delivery-brake-test",
          MUSE_DAEMON_DELIVERY_ENABLED: delivery,
          MUSE_INBOUND_REPLY_ENABLED: "true",
          MUSE_PROACTIVE_AGENT_TURN: "true",
          MUSE_REMINDER_AGENT_TURN: "true"
        },
        logger: false,
        matrixInboxFile: "/tmp/muse-delivery-brake-test/matrix.json",
        messaging: new MessagingProviderRegistry(),
        telegramInboxFile: "/tmp/muse-delivery-brake-test/telegram.json"
      });

      try {
        for (const starter of outboundStarters) expect(starter).not.toHaveBeenCalled();
        expect(mocks.createActivityTracker).not.toHaveBeenCalled();
        expect(mocks.createInboundAgentRun).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    }
  );

  it("preserves API outbound daemon construction when delivery is explicitly enabled", async () => {
    const server = buildServer({
      env: {
        HOME: "/tmp/muse-delivery-brake-enabled-test",
        MUSE_DAEMON_DELIVERY_ENABLED: "true"
      },
      logger: false
    });
    try {
      for (const starter of outboundStarters) expect(starter).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
