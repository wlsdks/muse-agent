import type { AgentRunRecord } from "@muse/runtime-state";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import type { CompatibilityRouteOptions } from "./compat-routes.js";
import { compatSessionDetail, sessionDetail, toSessionResponse } from "./compat-session-store.js";

// Direct coverage for the compat session-detail serializers (untested). The
// load-bearing bit is toSessionMessages SYNTHESIS (observed via compatSessionDetail):
// when there are no stored messages, the user input + assistant output are
// synthesized from the run; the 404/401 guards protect the read path.

const run = (over: Partial<AgentRunRecord> = {}): AgentRunRecord =>
  ({ completedAt: new Date(1_500), createdAt: new Date(1_000), id: "s1", input: "hello there", output: "hi back", updatedAt: new Date(2_000), ...over }) as unknown as AgentRunRecord;

const historyStore = (over: { run?: AgentRunRecord | null; messages?: unknown[]; toolCalls?: unknown[] } = {}): CompatibilityRouteOptions["historyStore"] =>
  ({
    findRun: async () => (over.run === null ? undefined : (over.run ?? run())),
    listMessages: async () => over.messages ?? [],
    listToolCalls: async () => over.toolCalls ?? []
  }) as unknown as CompatibilityRouteOptions["historyStore"];

const request = (over: { userId?: string } = {}): FastifyRequest =>
  ({ params: { sessionId: "s1" }, ...(over.userId !== undefined ? { auth: { userId: over.userId } } : {}) }) as unknown as FastifyRequest;
const reply = (): { r: FastifyReply; captured: { status: number | null; payload: unknown } } => {
  const captured = { payload: null as unknown, status: null as number | null };
  return { captured, r: { status: (c: number) => { captured.status = c; return { send: (p: unknown) => { captured.payload = p; } }; } } as unknown as FastifyReply };
};
const opts = (o: Partial<CompatibilityRouteOptions> = {}): CompatibilityRouteOptions => o as CompatibilityRouteOptions;

describe("sessionDetail", () => {
  it("404s when no history store is configured, and when the session is not found", async () => {
    const noStore = reply();
    await sessionDetail(request(), noStore.r, opts());
    expect(noStore.captured).toMatchObject({ payload: { code: "RUN_HISTORY_UNAVAILABLE" }, status: 404 });

    const missing = reply();
    await sessionDetail(request(), missing.r, opts({ historyStore: historyStore({ run: null }) }));
    expect(missing.captured).toMatchObject({ payload: { code: "SESSION_NOT_FOUND" }, status: 404 });
  });

  it("returns messages + run + session + toolCalls when found", async () => {
    const result = await sessionDetail(request(), reply().r, opts({ historyStore: historyStore({ messages: [{ content: "x", createdAt: new Date(1), role: "user" }], toolCalls: [{ id: "t" }] }) }));
    expect(Object.keys(result as object).sort()).toEqual(["messages", "run", "session", "toolCalls"]);
  });
});

describe("compatSessionDetail — message synthesis", () => {
  it("401s without an authenticated user", async () => {
    const { captured, r } = reply();
    await compatSessionDetail(request(), r, opts({ historyStore: historyStore() }));
    expect(captured.status).toBe(401);
  });

  it("SYNTHESIZES the user turn + assistant reply from the run when no messages are stored", async () => {
    const result = await compatSessionDetail(request({ userId: "u1" }), reply().r, opts({ historyStore: historyStore({ messages: [] }) }));
    expect((result as { messages: unknown }).messages).toEqual([
      { content: "hello there", role: "user", timestamp: 1_000 },
      { content: "hi back", role: "assistant", timestamp: 1_500 }
    ]);
  });

  it("synthesizes only the user turn when the run has no output", async () => {
    const result = await compatSessionDetail(request({ userId: "u1" }), reply().r, opts({ historyStore: historyStore({ messages: [], run: run({ output: undefined }) }) }));
    expect((result as { messages: readonly unknown[] }).messages).toEqual([{ content: "hello there", role: "user", timestamp: 1_000 }]);
  });

  it("maps STORED messages through when present", async () => {
    const result = await compatSessionDetail(request({ userId: "u1" }), reply().r, opts({ historyStore: historyStore({ messages: [{ content: "stored", createdAt: new Date(5_000), role: "assistant" }] }) }));
    expect((result as { messages: readonly unknown[] }).messages).toEqual([{ content: "stored", role: "assistant", timestamp: 5_000 }]);
  });
});

describe("toSessionResponse", () => {
  it("reports the synthesized message count, a 120-char preview, and last activity", async () => {
    expect(await toSessionResponse(run(), opts({ historyStore: historyStore({ messages: [] }) })))
      .toEqual({ lastActivity: 2_000, messageCount: 2, preview: "hello there", sessionId: "s1" });
    expect((await toSessionResponse(run({ input: "x".repeat(200) }), opts())).preview).toHaveLength(120);
  });
});
