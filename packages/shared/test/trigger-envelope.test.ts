import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createTriggerEnvelope,
  isTriggerEnvelope,
  type TriggerSource
} from "../src/index.js";

const OCCURRED_AT = "2026-07-30T00:00:00.000Z";
const RECEIVED_AT = "2026-07-30T00:00:01.000Z";

describe("TriggerEnvelope", () => {
  it.each([
    ["cron", "local-scheduler"],
    ["webhook", "capability-token"],
    ["reminder", "local-store"],
    ["manual", "owner-command"]
  ] as const)("expresses a %s occurrence with canonical provenance", (source, provenanceKind) => {
    const envelope = createTriggerEnvelope({
      generation: "occurrence-1",
      occurredAt: OCCURRED_AT,
      payload: { untrusted: "data" },
      receivedAt: RECEIVED_AT,
      source,
      sourceId: `${source}-1`
    });

    expect(envelope).toMatchObject({
      generation: "occurrence-1",
      occurredAt: OCCURRED_AT,
      payload: { untrusted: "data" },
      provenance: { kind: provenanceKind },
      receivedAt: RECEIVED_AT,
      schemaVersion: 1,
      source,
      sourceId: `${source}-1`
    });
    expect(envelope.dedupKey).toMatch(/^trigger:[a-f0-9]{64}$/u);
    expect(isTriggerEnvelope(envelope)).toBe(true);
  });

  it("keeps occurrence identity stable across delivery retries", () => {
    const input = {
      generation: "2026-07-30T09:00:00+09:00",
      occurredAt: OCCURRED_AT,
      receivedAt: RECEIVED_AT,
      source: "cron" as const,
      sourceId: "daily-brief"
    };

    const first = createTriggerEnvelope(input);
    const retry = createTriggerEnvelope({
      ...input,
      receivedAt: "2026-07-30T00:05:00.000Z"
    });
    const nextOccurrence = createTriggerEnvelope({
      ...input,
      generation: "2026-07-31T09:00:00+09:00"
    });

    expect(retry.dedupKey).toBe(first.dedupKey);
    expect(nextOccurrence.dedupKey).not.toBe(first.dedupKey);
  });

  it("normalizes parseable timestamps and rejects malformed identity or time", () => {
    const normalized = createTriggerEnvelope({
      generation: "g1",
      occurredAt: "2026-07-30T09:00:00+09:00",
      receivedAt: new Date(RECEIVED_AT),
      source: "manual",
      sourceId: "owner"
    });
    expect(normalized.occurredAt).toBe(OCCURRED_AT);
    expect(() => createTriggerEnvelope({
      generation: "g1",
      occurredAt: "not-a-date",
      receivedAt: RECEIVED_AT,
      source: "manual",
      sourceId: "owner"
    })).toThrow("occurredAt");
    expect(() => createTriggerEnvelope({
      generation: " ",
      occurredAt: OCCURRED_AT,
      receivedAt: RECEIVED_AT,
      source: "manual",
      sourceId: "owner"
    })).toThrow("generation");
  });

  it("rejects malformed envelopes and non-JSON payloads", () => {
    const valid = createTriggerEnvelope({
      generation: "g1",
      occurredAt: OCCURRED_AT,
      receivedAt: RECEIVED_AT,
      source: "webhook",
      sourceId: "flow-1"
    });
    expect(isTriggerEnvelope({ ...valid, occurredAt: "2026-07-30T00:00:00Z" })).toBe(false);
    expect(isTriggerEnvelope({ ...valid, provenance: { kind: "network" } })).toBe(false);
    expect(isTriggerEnvelope({ ...valid, provenance: { kind: "local-store" } })).toBe(false);
    expect(isTriggerEnvelope({ ...valid, dedupKey: "trigger:tampered" })).toBe(false);
    expect(isTriggerEnvelope({ ...valid, source: "provider-specific" as TriggerSource })).toBe(false);
    expect(isTriggerEnvelope({ ...valid, payload: Number.NaN })).toBe(false);
  });

  it("accepts only the deployed legacy reminder identity as an alternate dedup format", () => {
    const envelope = createTriggerEnvelope({
      generation: OCCURRED_AT,
      occurredAt: OCCURRED_AT,
      provenance: { kind: "local-store", ref: "reminders" },
      receivedAt: RECEIVED_AT,
      source: "reminder",
      sourceId: "rem-1"
    });
    const legacy = `reminder:${createHash("sha256")
      .update(JSON.stringify(["rem-1", OCCURRED_AT]))
      .digest("hex")}`;

    expect(isTriggerEnvelope({ ...envelope, dedupKey: legacy })).toBe(true);
    expect(isTriggerEnvelope({ ...envelope, dedupKey: "reminder:tampered" })).toBe(false);
  });
});
