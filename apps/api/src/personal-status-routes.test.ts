import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPersonalThread, linkArtifact, prepareContinuityReview, type AttunementState } from "@muse/attunement";
import type { UserMemory } from "@muse/memory";
import { MessagingProviderRegistry, type MessagingProvider } from "@muse/messaging";
import type { ResidentDaemonInspection } from "@muse/runtime-state";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { collectPersonalStatus, registerPersonalStatusRoutes, type PersonalStatusRoutesOptions } from "./personal-status-routes.js";
import { buildServer } from "./server.js";
import type { ServerOptions } from "./server-options.js";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const USER_ID = "owner";

function resident(delivery = "false"): ResidentDaemonInspection {
  return {
    effectiveRuntimeEnv: { HOME: "/isolated", MUSE_DAEMON_DELIVERY_ENABLED: delivery },
    observation: {
      artifact: "valid",
      autostartProbe: "ok",
      heartbeat: "fresh",
      liveDefinitionMatches: true,
      liveProbe: "ok",
      orphanProbe: "ok",
      orphanProcessCount: 0,
      orphanRootCount: 0,
      pidAgreement: true,
      platform: "darwin",
      runtime: "running",
      stableMuseCommand: true
    }
  };
}

function fingerprint(file: string): string {
  const stat = statSync(file);
  return `${stat.size.toString()}:${stat.mode.toString()}:${stat.mtimeMs.toString()}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

async function fixture(options: { readonly provenance?: readonly Record<string, unknown>[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "muse-personal-status-"));
  const files = {
    approvals: join(root, "pending-approvals.json"),
    attunement: join(root, "attunement.json"),
    provenance: join(root, "belief-provenance.json"),
    proposals: join(root, "proposed-actions.json"),
    reconfirmation: join(root, "reconfirm-card-answered.json"),
    residentHeartbeat: join(root, "daemon-heartbeat.json"),
    residentPlist: join(root, "com.muse.daemon.plist"),
    userMemory: join(root, "user-memory.json"),
    vetoes: join(root, "vetoes.json")
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(files.approvals, JSON.stringify({ pending: [
    {
      arguments: {}, createdAt: "2026-07-22T11:00:00.000Z", draft: "private draft", expiresAt: "2026-07-22T13:00:00.000Z",
      id: "approval_owner", providerId: "telegram", risk: "execute", source: "chat", tool: "send_message", userId: USER_ID
    },
    {
      arguments: {}, createdAt: "2026-07-22T11:00:00.000Z", draft: "other", expiresAt: "2026-07-22T13:00:00.000Z",
      id: "approval_other", providerId: "telegram", risk: "execute", source: "chat", tool: "send_message", userId: "other"
    }
  ] }));
  writeFileSync(files.proposals, JSON.stringify({ proposals: [
    {
      createdAt: "2026-07-22T11:10:00.000Z", destination: "private", expiresAt: "2026-07-22T14:00:00.000Z", id: "proposal_owner",
      kind: "message", providerId: "telegram", reason: "약속한 후속 연락", status: "pending", summary: "후속 연락 초안", text: "private", userId: USER_ID
    },
    {
      createdAt: "2026-07-22T11:10:00.000Z", destination: "private", expiresAt: NOW.toISOString(), id: "proposal_equal_expiry",
      kind: "message", providerId: "telegram", reason: "expired", status: "pending", summary: "expired", text: "private", userId: USER_ID
    }
  ] }));
  writeFileSync(files.provenance, JSON.stringify({ entries: options.provenance ?? [
    {
      evidenceExcerpt: "나는 아침에 집중이 잘 돼", key: "focus_time", kind: "preference", learnedAt: "2026-07-21T08:00:00.000Z",
      sessionId: "session_1", source: "auto", userId: USER_ID, value: "morning"
    }
  ] }));
  writeFileSync(files.vetoes, JSON.stringify({ vetoes: [
    { id: "veto_1", objectiveId: "followup", reason: "먼저 묻기", scope: "messaging", userId: USER_ID, vetoedAt: "2026-07-20T09:00:00.000Z" }
  ] }));
  writeFileSync(files.reconfirmation, JSON.stringify({ lastAnsweredDate: "2026-07-21" }));
  writeFileSync(files.residentHeartbeat, JSON.stringify({ at: "2026-07-22T11:59:00.000Z", pid: 42 }));
  writeFileSync(files.residentPlist, "<plist><dict><key>Label</key><string>com.muse.daemon</string></dict></plist>\n");
  const thread = await createPersonalThread(files.attunement, { kind: "work", title: "출시 준비" }, {
    idFactory: () => "thread_1",
    now: () => new Date("2026-07-21T09:00:00.000Z")
  });
  await linkArtifact(files.attunement, {
    artifactId: "task_1", artifactType: "task", role: "next-step", threadId: thread.id
  }, {
    now: () => new Date("2026-07-21T09:01:00.000Z"),
    validateArtifact: async (input) => input
  });
  const attunement = JSON.parse(readFileSync(files.attunement, "utf8")) as { deliveries: unknown[] };
  attunement.deliveries.push({
    evidenceClass: "organic", evidenceRefs: [], id: "delivery_1", openedAt: "2026-07-22T10:00:00.000Z", policyVersion: 0, threadId: thread.id
  });
  writeFileSync(files.attunement, `${JSON.stringify(attunement, null, 2)}\n`);
  const memory: UserMemory = {
    facts: {},
    preferences: { focus_time: "morning" },
    recentTopics: [],
    updatedAt: NOW,
    userId: USER_ID
  };
  writeFileSync(files.userMemory, JSON.stringify({ ...memory, updatedAt: memory.updatedAt.toISOString() }));
  const findByUserId = vi.fn(async () => {
    const parsed = JSON.parse(readFileSync(files.userMemory, "utf8")) as Omit<UserMemory, "updatedAt"> & { readonly updatedAt: string };
    return { ...parsed, updatedAt: new Date(parsed.updatedAt) };
  });
  const upsertUserModelSlot = vi.fn();
  const removeUserModelSlot = vi.fn();
  const residentInspector = vi.fn(async () => {
    readFileSync(files.residentHeartbeat);
    readFileSync(files.residentPlist);
    return resident();
  });
  const userMemoryStore = { findByUserId, removeUserModelSlot, upsertUserModelSlot };
  const routeOptions: PersonalStatusRoutesOptions = {
    attunementFile: files.attunement,
    authService: undefined,
    beliefProvenanceFile: files.provenance,
    defaultUserId: USER_ID,
    env: { HOME: root },
    now: () => NOW,
    pendingApprovalsFile: files.approvals,
    proposedActionsFile: files.proposals,
    reconfirmCardAnsweredFile: files.reconfirmation,
    residentInspector,
    userMemoryStore,
    vetoesFile: files.vetoes
  };
  return { files, findByUserId, removeUserModelSlot, residentInspector, root, routeOptions, upsertUserModelSlot };
}

describe("GET /api/personal-status", () => {
  it("projects owner-scoped actionable cards without changing any backing source", async () => {
    const state = await fixture();
    const before = {
      entries: readdirSync(state.root).sort(),
      files: Object.fromEntries(Object.entries(state.files).map(([key, file]) => [key, fingerprint(file)]))
    };
    const server = Fastify();
    registerPersonalStatusRoutes(server, state.routeOptions);
    const response = await server.inject({ method: "GET", url: "/api/personal-status" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["cards", "generatedAt", "overall", "schemaVersion", "sources"]);
    expect(body).toMatchObject({ generatedAt: NOW.toISOString(), overall: "held", schemaVersion: "muse.personal-status/v1" });
    expect(body.cards.map((card: { readonly id: string }) => card.id)).toEqual(expect.arrayContaining([
      "runtime:resident", "approval:approval_owner", "proposal:proposal_owner", "feedback:delivery_1",
      "thread:thread_thread_1", "learning:preference:focus_time", "veto:veto_1"
    ]));
    expect(body.cards.some((card: { readonly id: string }) => card.id === "approval:approval_other")).toBe(false);
    expect(body.cards.some((card: { readonly id: string }) => card.id === "proposal:proposal_equal_expiry")).toBe(false);
    expect(state.findByUserId).toHaveBeenCalledWith(USER_ID);
    expect(state.residentInspector).toHaveBeenCalledTimes(1);
    expect(state.upsertUserModelSlot).not.toHaveBeenCalled();
    expect(state.removeUserModelSlot).not.toHaveBeenCalled();
    expect({
      entries: readdirSync(state.root).sort(),
      files: Object.fromEntries(Object.entries(state.files).map(([key, file]) => [key, fingerprint(file)]))
    }).toEqual(before);
  });

  it("keeps partial source corruption visible while retaining healthy cards", async () => {
    const state = await fixture();
    writeFileSync(state.files.proposals, "{malformed private");
    const status = await collectPersonalStatus(state.routeOptions);

    expect(status.cards.some((card) => card.id === "approval:approval_owner")).toBe(true);
    expect(status.cards).toContainEqual(expect.objectContaining({ id: "source:proposed-actions", status: "unavailable" }));
    expect(status.sources).toContainEqual(expect.objectContaining({ errorCode: "invalid-json", id: "proposed-actions", result: "corrupt" }));
  });

  it("uses persisted order as the tie-break for same-timestamp learning retractions", async () => {
    const base = {
      key: "focus_time", kind: "preference", learnedAt: "2026-07-21T08:00:00.000Z", source: "user", userId: USER_ID
    } as const;
    const valueLast = await fixture({ provenance: [{ ...base, retraction: true, value: "" }, { ...base, value: "morning" }] });
    const retractionLast = await fixture({ provenance: [{ ...base, value: "morning" }, { ...base, retraction: true, value: "" }] });

    await expect(collectPersonalStatus(valueLast.routeOptions)).resolves.toMatchObject({
      cards: expect.arrayContaining([expect.objectContaining({ id: "learning:preference:focus_time" })])
    });
    const retracted = await collectPersonalStatus(retractionLast.routeOptions);
    expect(retracted.cards.some((card) => card.id === "learning:preference:focus_time")).toBe(false);
  });

  it("treats an empty owner memory snapshot as available-empty instead of crashing", async () => {
    const state = await fixture();
    const status = await collectPersonalStatus({
      ...state.routeOptions,
      userMemoryStore: { findByUserId: vi.fn(async () => undefined) }
    });

    expect(status.cards.some((card) => card.kind === "learning-change")).toBe(false);
    expect(status.sources).toContainEqual(expect.objectContaining({ id: "user-memory", includedCount: 0, result: "available" }));
    expect(status.sources.find((row) => row.id === "belief-provenance")?.excludedCount).toBeGreaterThan(0);
  });

  it.each(["controlled", "unclassified"] as const)("keeps %s continuity evidence on a held review path", async (evidenceClass) => {
    const state = await fixture();
    const attunement = JSON.parse(readFileSync(state.files.attunement, "utf8")) as { deliveries: Array<{ evidenceClass: string }> };
    attunement.deliveries[0]!.evidenceClass = evidenceClass;
    writeFileSync(state.files.attunement, `${JSON.stringify(attunement, null, 2)}\n`);

    const status = await collectPersonalStatus(state.routeOptions);
    expect(status.cards).toContainEqual(expect.objectContaining({
      id: "feedback:delivery_1",
      kind: "continuity-feedback",
      status: "held"
    }));
    expect(status.cards.filter((card) => card.kind === "learning-change")).toHaveLength(1);
  });

  it("keeps the canonical pending organic review visible ahead of earlier technical deliveries", async () => {
    const state = await fixture();
    const attunement = JSON.parse(readFileSync(state.files.attunement, "utf8")) as {
      deliveries: Array<{ evidenceClass: string; evidenceRefs: unknown[]; id: string; openedAt: string; policyVersion: number; threadId: string }>;
    };
    const organic = { ...attunement.deliveries[0]!, id: "organic_pending", openedAt: "2026-07-22T10:30:00.000Z" };
    attunement.deliveries = Array.from({ length: 20 }, (_, index) => ({
      ...organic,
      evidenceClass: "controlled",
      id: `controlled_${index.toString().padStart(2, "0")}`,
      openedAt: `2026-07-22T09:${index.toString().padStart(2, "0")}:00.000Z`
    })).concat(organic);
    writeFileSync(state.files.attunement, `${JSON.stringify(attunement, null, 2)}\n`);

    const status = await collectPersonalStatus(state.routeOptions);
    expect(status.cards).toContainEqual(expect.objectContaining({ id: "feedback:organic_pending", status: "attention" }));
    expect(status.cards).toContainEqual(expect.objectContaining({ id: "feedback:controlled_00", status: "held" }));
  });

  it("uses the canonical delivery-id tie-break for same-time organic feedback", async () => {
    const state = await fixture();
    const attunement = JSON.parse(readFileSync(state.files.attunement, "utf8")) as AttunementState & {
      deliveries: Array<{ evidenceClass: "organic"; evidenceRefs: never[]; id: string; openedAt: string; policyVersion: number; threadId: string }>;
    };
    const base = attunement.deliveries[0]!;
    attunement.deliveries = [
      { ...base, id: "z_pending", openedAt: "2026-07-22T10:00:00.000Z" },
      { ...base, id: "a_pending", openedAt: "2026-07-22T10:00:00.000Z" }
    ];
    writeFileSync(state.files.attunement, `${JSON.stringify(attunement, null, 2)}\n`);

    const canonical = await prepareContinuityReview(attunement, async () => undefined);
    const status = await collectPersonalStatus(state.routeOptions);
    expect(canonical.next?.deliveryId).toBe("a_pending");
    expect(status.cards.filter((card) => card.kind === "continuity-feedback").map((card) => card.id))
      .toEqual([`feedback:${canonical.next?.deliveryId}`]);
  });

  it("excludes oversized owner records without failing the aggregate", async () => {
    const state = await fixture({ provenance: [{
      evidenceExcerpt: "x".repeat(281), key: "focus_time", kind: "preference", learnedAt: "2026-07-21T08:00:00.000Z",
      sessionId: "session_1", source: "auto", userId: USER_ID, value: "morning"
    }] });
    const approvals = JSON.parse(readFileSync(state.files.approvals, "utf8")) as { pending: Array<{ id: string }> };
    approvals.pending[0]!.id = "a".repeat(200);
    writeFileSync(state.files.approvals, JSON.stringify(approvals));

    const status = await collectPersonalStatus(state.routeOptions);
    expect(status.cards.some((card) => card.kind === "external-approval")).toBe(false);
    expect(status.cards.some((card) => card.kind === "learning-change")).toBe(false);
    expect(status.sources.find((row) => row.id === "pending-approvals")?.excludedCount).toBeGreaterThan(0);
    expect(status.sources.find((row) => row.id === "belief-provenance")?.excludedCount).toBeGreaterThan(0);
  });

  it("rejects identity-bearing query input", async () => {
    const state = await fixture();
    const server = Fastify();
    registerPersonalStatusRoutes(server, state.routeOptions);
    const response = await server.inject({ method: "GET", url: "/api/personal-status?userId=other" });
    expect(response.statusCode).toBe(400);
    expect(state.findByUserId).not.toHaveBeenCalled();
  });

  it("does not cross approval resolution, messaging send, or POST handler boundaries on the production server GET", async () => {
    const state = await fixture();
    const approvalToolResolver = vi.fn(() => undefined);
    const send = vi.fn(async (message: { readonly destination: string }) => ({
      destination: message.destination,
      messageId: "must-not-send",
      providerId: "telegram" as const
    }));
    const provider: MessagingProvider = {
      describe: () => ({ description: "test", displayName: "Telegram", id: "telegram" }),
      id: "telegram",
      send
    };
    const server = buildServer({
      approvalToolResolver,
      attunementFile: state.files.attunement,
      beliefProvenanceFile: state.files.provenance,
      env: { HOME: state.root, MUSE_DEFAULT_USER_ID: USER_ID, MUSE_LOCAL_ONLY: "true" },
      localOnly: true,
      logger: false,
      messaging: new MessagingProviderRegistry([provider]),
      pendingApprovalsFile: state.files.approvals,
      proposedActionsFile: state.files.proposals,
      reconfirmCardAnsweredFile: state.files.reconfirmation,
      userMemoryStore: state.routeOptions.userMemoryStore as ServerOptions["userMemoryStore"],
      vetoesFile: state.files.vetoes
    });
    const postHandler = vi.fn();
    server.addHook("onRequest", async (request) => {
      if (request.method === "POST") postHandler();
    });

    const response = await server.inject({ method: "GET", url: "/api/personal-status" });
    expect(response.statusCode).toBe(200);
    expect(approvalToolResolver).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(postHandler).not.toHaveBeenCalled();
    await server.close();
  });
});
