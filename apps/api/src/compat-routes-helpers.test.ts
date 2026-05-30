import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { createRecord, findCompatRecord, readIfMatchVersion, toCompatRuntimeSetting, type CompatCollection, type CompatRecord } from "./compat-routes.js";

type RuntimeSettingArg = Parameters<typeof toCompatRuntimeSetting>[0];

// Direct coverage for the generic compat-record helpers + the If-Match version
// parser (untested). readIfMatchVersion backs optimistic concurrency (a typo'd
// header must NOT silently become a version); findCompatRecord resolves by
// id → name → channelId; createRecord assigns/keeps the id and preserves
// createdAt across a re-create.

describe("readIfMatchVersion", () => {
  const req = (ifMatch?: string | string[]): FastifyRequest => ({ headers: ifMatch === undefined ? {} : { "if-match": ifMatch } }) as unknown as FastifyRequest;

  it("parses a quoted or plain version, takes the first of an array, and returns undefined for a non-numeric / missing header", () => {
    expect(readIfMatchVersion(req('"5"'))).toBe(5);
    expect(readIfMatchVersion(req("7"))).toBe(7);
    expect(readIfMatchVersion(req(['"3"', "9"]))).toBe(3);
    expect(readIfMatchVersion(req("abc"))).toBeUndefined();
    expect(readIfMatchVersion(req())).toBeUndefined();
  });
});

describe("findCompatRecord", () => {
  it("resolves by id, then falls back to a name or channelId match", () => {
    const collection: CompatCollection = new Map();
    collection.set("id1", { channelId: "ch1", id: "id1", name: "alpha" } as unknown as CompatRecord);
    collection.set("id2", { id: "id2", name: "beta" } as unknown as CompatRecord);
    expect(findCompatRecord(collection, "id1")?.id).toBe("id1");
    expect(findCompatRecord(collection, "beta")?.id).toBe("id2"); // by name
    expect(findCompatRecord(collection, "ch1")?.id).toBe("id1"); // by channelId
    expect(findCompatRecord(collection, "nope")).toBeUndefined();
  });
});

describe("createRecord", () => {
  it("generates an id when absent, stores the record, and stamps created/updated", () => {
    const collection: CompatCollection = new Map();
    const record = createRecord(collection, { name: "x" }, "rec");
    expect(record.id.startsWith("rec")).toBe(true);
    expect(typeof record.createdAt).toBe("string");
    expect(typeof record.updatedAt).toBe("string");
    expect(collection.get(record.id)?.name).toBe("x");
  });

  it("honors an explicit id and PRESERVES createdAt across a re-create", () => {
    const collection: CompatCollection = new Map();
    const first = createRecord(collection, { id: "fixed", name: "v1" }, "rec");
    const second = createRecord(collection, { id: "fixed", name: "v2" }, "rec");
    expect(second.id).toBe("fixed");
    expect(second.createdAt).toBe(first.createdAt); // createdAt preserved
    expect(collection.get("fixed")?.name).toBe("v2"); // latest value stored
  });
});

describe("toCompatRuntimeSetting", () => {
  it("maps a RuntimeSetting to the response shape (null fallbacks, ISO timestamp, type upper-cased)", () => {
    const setting = { category: "c", description: null, key: "k", type: "string", updatedAt: new Date(1_000), updatedBy: null, value: "v" } as unknown as RuntimeSettingArg;
    expect(toCompatRuntimeSetting(setting)).toEqual({
      category: "c", description: null, key: "k", type: "STRING", updatedAt: "1970-01-01T00:00:01.000Z", updatedBy: null, value: "v"
    });
  });
});
