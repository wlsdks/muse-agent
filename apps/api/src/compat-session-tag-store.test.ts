import type { SessionTag } from "@muse/runtime-state";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import type { CompatibilityRouteOptions } from "./compat-routes.js";
import {
  createSessionTag,
  deleteSessionTag,
  deleteSessionTags,
  listSessionTags,
  safeIsoFromMs,
  toSessionTagCompatRecord
} from "./compat-session-tag-store.js";

// Direct coverage for the compat session-tag store (untested module). Two
// branches matter: it delegates to a configured SessionTagStore when present,
// else falls back to the file-private compat state. Plus the pure mappers:
// toSessionTagCompatRecord and safeIsoFromMs (the NaN/non-number → epoch guard
// that keeps a corrupt timestamp from producing an "Invalid Date" ISO).

const tag = (over: Partial<SessionTag> = {}): SessionTag =>
  ({ comment: null, createdAt: 1_000, createdBy: "admin", id: "t1", label: "important", sessionId: "s1", ...over }) as unknown as SessionTag;

describe("safeIsoFromMs", () => {
  it("converts a finite ms to ISO and falls back to the epoch for NaN / Infinity / non-number", () => {
    expect(safeIsoFromMs(1_000)).toBe("1970-01-01T00:00:01.000Z");
    expect(safeIsoFromMs(Number.NaN)).toBe("1970-01-01T00:00:00.000Z");
    expect(safeIsoFromMs(Number.POSITIVE_INFINITY)).toBe("1970-01-01T00:00:00.000Z");
    expect(safeIsoFromMs("x" as unknown as number)).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("toSessionTagCompatRecord", () => {
  it("maps a SessionTag to the compat record (comment ?? null, createdAt == updatedAt)", () => {
    expect(toSessionTagCompatRecord(tag({ createdAt: 1_000 }))).toEqual({
      comment: null, createdAt: "1970-01-01T00:00:01.000Z", id: "t1", label: "important", sessionId: "s1", updatedAt: "1970-01-01T00:00:01.000Z"
    });
    expect(toSessionTagCompatRecord(tag({ comment: "note" })).comment).toBe("note");
  });
});

describe("session-tag helpers — configured-store delegation", () => {
  interface Call { op: string; args: unknown[] }
  const fakeStore = (calls: Call[]) => ({
    create: async (input: { label: string; sessionId: string; comment: string | null; createdBy: string }) => {
      calls.push({ args: [input], op: "create" });
      return tag({ comment: input.comment ?? undefined, createdAt: 5_000, createdBy: input.createdBy, id: "new", label: input.label, sessionId: input.sessionId });
    },
    delete: async (sessionId: string, tagId: string) => { calls.push({ args: [sessionId, tagId], op: "delete" }); return true; },
    deleteBySession: async (sessionId: string) => { calls.push({ args: [sessionId], op: "deleteBySession" }); },
    listBySession: async (sessionId: string) => { calls.push({ args: [sessionId], op: "list" }); return [tag({ createdAt: 5_000, id: "a", label: "L", sessionId })]; }
  });
  const optionsWith = (calls: Call[]): CompatibilityRouteOptions => ({ sessionTagStore: fakeStore(calls) }) as unknown as CompatibilityRouteOptions;
  const request = { auth: { userId: "u1" } } as unknown as FastifyRequest;

  it("createSessionTag delegates with the auth user as createdBy and returns the mapped record", async () => {
    const calls: Call[] = [];
    const record = await createSessionTag(optionsWith(calls), request, "s1", "important", "c");
    expect(record).toMatchObject({ comment: "c", id: "new", label: "important", sessionId: "s1" });
    expect(calls[0]).toMatchObject({ args: [{ createdBy: "u1" }], op: "create" });
  });

  it("listSessionTags maps the stored tags, deleteSessionTag returns the store's boolean, deleteSessionTags delegates", async () => {
    const calls: Call[] = [];
    const options = optionsWith(calls);
    expect((await listSessionTags(options, "s1")).map((t) => t.id)).toEqual(["a"]);
    expect(await deleteSessionTag(options, "s1", "a")).toBe(true);
    await deleteSessionTags(options, "s1");
    expect(calls.map((c) => c.op)).toEqual(["list", "delete", "deleteBySession"]);
  });
});

describe("session-tag helpers — file-state fallback (no configured store)", () => {
  const options = {} as CompatibilityRouteOptions; // no sessionTagStore
  const request = {} as FastifyRequest;

  it("round-trips create → list → delete through the in-process state", async () => {
    const sessionId = `fallback-${process.pid.toString()}-${Date.now().toString()}`; // unique to avoid shared-Map collisions
    const created = await createSessionTag(options, request, sessionId, "starred", null);
    expect((await listSessionTags(options, sessionId)).map((t) => t.id)).toEqual([created.id]);
    expect(await deleteSessionTag(options, sessionId, created.id)).toBe(true);
    expect(await listSessionTags(options, sessionId)).toEqual([]);
    expect(await deleteSessionTag(options, sessionId, created.id)).toBe(false); // already gone
  });
});
