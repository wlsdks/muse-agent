import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { mintWebhookTriggerToken, registerWebhookTriggerRoutes, WEBHOOK_FIRE_COOLDOWN_MS, webhookTokensEqual } from "./webhook-trigger-routes.js";

import type { ScheduledJob } from "@muse/scheduler";

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    agentPrompt: "summarize",
    createdAt: new Date(),
    cronExpression: "0 9 * * *",
    enabled: true,
    id: "job_1",
    jobType: "agent",
    maxRetryCount: 3,
    name: "brief",
    retryOnFailure: false,
    tags: [],
    toolArguments: {},
    updatedAt: new Date(),
    ...overrides
  } as ScheduledJob;
}

function fakeService(jobs: ScheduledJob[]) {
  return {
    findById: vi.fn(async (id: string) => jobs.find((candidate) => candidate.id === id)),
    list: vi.fn(async () => jobs),
    trigger: vi.fn(async () => "ok"),
    update: vi.fn(async (id: string, input: Record<string, unknown>) => {
      const index = jobs.findIndex((candidate) => candidate.id === id);
      if (index < 0) return undefined;
      jobs[index] = { ...jobs[index]!, ...input } as ScheduledJob;
      return jobs[index];
    })
  };
}

function serverWith(jobs: ScheduledJob[], authed = true) {
  const server = Fastify();
  const service = fakeService(jobs);
  registerWebhookTriggerRoutes(server, {
    requireAuthenticated: () => authed,
    scheduler: { service } as never
  });
  return { server, service };
}

describe("mintWebhookTriggerToken / webhookTokensEqual", () => {
  it("mints unique wht_-prefixed tokens", () => {
    const a = mintWebhookTriggerToken();
    const b = mintWebhookTriggerToken();
    expect(a).toMatch(/^wht_[A-Za-z0-9_-]{20,}$/u);
    expect(a).not.toBe(b);
  });

  it("token equality is exact", () => {
    const token = mintWebhookTriggerToken();
    expect(webhookTokensEqual(token, token)).toBe(true);
    expect(webhookTokensEqual(token, `${token.slice(0, -1)}x`)).toBe(false);
    expect(webhookTokensEqual(token, "wht_short")).toBe(false);
  });
});

describe("POST /api/hooks/flows/:token — the inbound trigger", () => {
  it("a valid token on an ENABLED flow fires exactly that job", async () => {
    const jobs = [job({ id: "job_a", webhookTriggerToken: "wht_tokenA_000000000000000000" }), job({ id: "job_b" })];
    const { server, service } = serverWith(jobs);
    const res = await server.inject({ method: "POST", url: "/api/hooks/flows/wht_tokenA_000000000000000000" });
    expect(res.statusCode).toBe(200);
    // ACK only: the run result must NEVER ride the public response — a
    // trigger token grants RUN, not READ.
    expect(JSON.parse(res.body)).toEqual({ fired: true, jobId: "job_a" });
    expect(res.body).not.toContain("ok");
    expect(service.trigger).toHaveBeenCalledTimes(1);
    expect(service.trigger).toHaveBeenCalledWith("job_a");
    await server.close();
  });

  it("an unknown token is a 404 and NOTHING fires", async () => {
    const jobs = [job({ webhookTriggerToken: "wht_realtoken_0000000000000000" })];
    const { server, service } = serverWith(jobs);
    const res = await server.inject({ method: "POST", url: "/api/hooks/flows/wht_wrongtoken_000000000000000" });
    expect(res.statusCode).toBe(404);
    expect(service.trigger).not.toHaveBeenCalled();
    await server.close();
  });

  it("a DISABLED flow's valid token is the same 404 (no oracle) and NOTHING fires", async () => {
    const jobs = [job({ enabled: false, webhookTriggerToken: "wht_pausedtok_0000000000000000" })];
    const { server, service } = serverWith(jobs);
    const res = await server.inject({ method: "POST", url: "/api/hooks/flows/wht_pausedtok_0000000000000000" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
    expect(service.trigger).not.toHaveBeenCalled();
    await server.close();
  });

  it("a malformed token (no prefix / oversized) 404s without listing jobs", async () => {
    const jobs = [job({ webhookTriggerToken: "wht_realtoken_0000000000000000" })];
    const { server, service } = serverWith(jobs);
    const bad = await server.inject({ method: "POST", url: "/api/hooks/flows/nope" });
    expect(bad.statusCode).toBe(404);
    // Fastify's own URI limit rejects the oversized token before the handler.
    const huge = await server.inject({ method: "POST", url: `/api/hooks/flows/wht_${"a".repeat(300)}` });
    expect([404, 414]).toContain(huge.statusCode);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.trigger).not.toHaveBeenCalled();
    await server.close();
  });
});

describe("token management routes (authenticated)", () => {
  it("mint returns a token + urlPath and persists it on the job", async () => {
    const jobs = [job()];
    const { server, service } = serverWith(jobs);
    const res = await server.inject({ method: "POST", url: "/api/scheduler/jobs/job_1/webhook-token" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { token: string; urlPath: string };
    expect(body.token).toMatch(/^wht_/u);
    expect(body.urlPath).toBe(`/api/hooks/flows/${body.token}`);
    expect(service.update).toHaveBeenCalledTimes(1);
    expect(jobs[0]!.webhookTriggerToken).toBe(body.token);
    await server.close();
  });

  it("re-minting ROTATES: the old token stops firing, the new one fires", async () => {
    const jobs = [job()];
    const { server } = serverWith(jobs);
    const first = JSON.parse((await server.inject({ method: "POST", url: "/api/scheduler/jobs/job_1/webhook-token" })).body) as { token: string };
    const second = JSON.parse((await server.inject({ method: "POST", url: "/api/scheduler/jobs/job_1/webhook-token" })).body) as { token: string };
    expect(second.token).not.toBe(first.token);
    const old = await server.inject({ method: "POST", url: `/api/hooks/flows/${first.token}` });
    expect(old.statusCode).toBe(404);
    const fresh = await server.inject({ method: "POST", url: `/api/hooks/flows/${second.token}` });
    expect(fresh.statusCode).toBe(200);
    await server.close();
  });

  it("revoke clears the token and the old URL dies", async () => {
    const jobs = [job({ webhookTriggerToken: "wht_livetoken_0000000000000000" })];
    const { server } = serverWith(jobs);
    const res = await server.inject({ method: "DELETE", url: "/api/scheduler/jobs/job_1/webhook-token" });
    expect(res.statusCode).toBe(204);
    expect(jobs[0]!.webhookTriggerToken).toBeNull();
    const fire = await server.inject({ method: "POST", url: "/api/hooks/flows/wht_livetoken_0000000000000000" });
    expect(fire.statusCode).toBe(404);
    await server.close();
  });

  it("management routes are auth-gated; the PUBLIC hook route is not", async () => {
    const jobs = [job({ webhookTriggerToken: "wht_livetoken_0000000000000000" })];
    const server = Fastify();
    const service = fakeService(jobs);
    registerWebhookTriggerRoutes(server, {
      requireAuthenticated: (_request, reply) => {
        void (reply as { status(code: number): { send(body: unknown): void } }).status(401).send({ error: "unauthorized" });
        return false;
      },
      scheduler: { service } as never
    });
    const mint = await server.inject({ method: "POST", url: "/api/scheduler/jobs/job_1/webhook-token" });
    expect(mint.statusCode).toBe(401);
    expect(service.update).not.toHaveBeenCalled();
    const fire = await server.inject({ method: "POST", url: "/api/hooks/flows/wht_livetoken_0000000000000000" });
    expect(fire.statusCode).toBe(200);
    await server.close();
  });
});

describe("generic PATCH cannot touch the webhook trigger token", () => {
  it("a body that tries to set webhookTriggerToken is ignored; the existing token is preserved", async () => {
    const { parseScheduledJobInput } = await import("./scheduler-routes.js");
    const existing = job({ webhookTriggerToken: "wht_livetoken_0000000000000000" });
    const parsed = parseScheduledJobInput({ webhookTriggerToken: "wht_evil" }, existing);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.webhookTriggerToken).toBe("wht_livetoken_0000000000000000");
    }
  });

  it("an unrelated PATCH (rename) preserves the existing token; a tokenless job stays tokenless", async () => {
    const { parseScheduledJobInput } = await import("./scheduler-routes.js");
    const withToken = parseScheduledJobInput({ name: "새 이름" }, job({ webhookTriggerToken: "wht_livetoken_0000000000000000" }));
    expect(withToken.ok && withToken.value.webhookTriggerToken).toBe("wht_livetoken_0000000000000000");
    const without = parseScheduledJobInput({ name: "새 이름" }, job());
    expect(without.ok && without.value.webhookTriggerToken).toBeUndefined();
  });
});

describe("per-token fire cooldown", () => {
  it("a second fire within the cooldown is 429 and does NOT trigger; after the window it fires again", async () => {
    const jobs = [job({ webhookTriggerToken: "wht_cooldown_00000000000000000" })];
    const server = Fastify();
    const service = fakeService(jobs);
    let clock = 1_000_000;
    registerWebhookTriggerRoutes(server, {
      nowMs: () => clock,
      requireAuthenticated: () => true,
      scheduler: { service } as never
    });
    const url = "/api/hooks/flows/wht_cooldown_00000000000000000";
    expect((await server.inject({ method: "POST", url })).statusCode).toBe(200);
    const blocked = await server.inject({ method: "POST", url });
    expect(blocked.statusCode).toBe(429);
    expect(service.trigger).toHaveBeenCalledTimes(1);
    clock += WEBHOOK_FIRE_COOLDOWN_MS + 1;
    expect((await server.inject({ method: "POST", url })).statusCode).toBe(200);
    expect(service.trigger).toHaveBeenCalledTimes(2);
    await server.close();
  });
});
