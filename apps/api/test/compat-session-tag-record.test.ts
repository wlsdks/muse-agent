import type { SessionTag } from "@muse/runtime-state";
import { describe, expect, it } from "vitest";

import { safeIsoFromMs, toSessionTagCompatRecord } from "../src/compat-session-tag-store.js";

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

function tag(overrides: Partial<SessionTag> = {}): SessionTag {
  return {
    comment: null,
    createdAt: 1_700_000_000_000,
    id: "tag_1",
    label: "alpha",
    sessionId: "sess_1",
    ...overrides
  };
}

describe("safeIsoFromMs (compat-session-tag record-render finite-Date guard)", () => {
  it("converts a normal ms to ISO-8601", () => {
    expect(safeIsoFromMs(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(safeIsoFromMs(0)).toBe(EPOCH_ISO);
  });

  it("falls back to the epoch ISO when ms is NaN / Infinity / -Infinity (would have crashed toISOString)", () => {
    expect(safeIsoFromMs(Number.NaN)).toBe(EPOCH_ISO);
    expect(safeIsoFromMs(Number.POSITIVE_INFINITY)).toBe(EPOCH_ISO);
    expect(safeIsoFromMs(Number.NEGATIVE_INFINITY)).toBe(EPOCH_ISO);
  });

  it("falls back to the epoch ISO when ms exceeds the Date range (RangeError defence on the /compat/sessions/<id>/tags list response)", () => {
    expect(safeIsoFromMs(9e15 + 1)).toBe(EPOCH_ISO);
    expect(safeIsoFromMs(-9e15 - 1)).toBe(EPOCH_ISO);
  });

  it("falls back to the epoch ISO when ms is the wrong type (defensive against DB Number() coercion producing non-number)", () => {
    expect(safeIsoFromMs(undefined as unknown as number)).toBe(EPOCH_ISO);
    expect(safeIsoFromMs(null as unknown as number)).toBe(EPOCH_ISO);
    expect(safeIsoFromMs("1700000000000" as unknown as number)).toBe(EPOCH_ISO);
  });
});

describe("toSessionTagCompatRecord (compat layer record-render)", () => {
  it("renders a clean tag with createdAt = updatedAt as ISO-8601", () => {
    const record = toSessionTagCompatRecord(tag({ createdAt: 1_700_000_000_000 }));
    expect(record.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(record.updatedAt).toBe(record.createdAt);
    expect(record.id).toBe("tag_1");
    expect(record.label).toBe("alpha");
    expect(record.sessionId).toBe("sess_1");
    expect(record.comment).toBeNull();
  });

  it("renders a corrupt tag (createdAt=NaN from a poisoned DB row) without crashing the whole tag list", () => {
    const record = toSessionTagCompatRecord(tag({ createdAt: Number.NaN }));
    expect(record.createdAt).toBe(EPOCH_ISO);
    expect(record.updatedAt).toBe(EPOCH_ISO);
    expect(record.id).toBe("tag_1");
  });

  it("preserves a non-null comment when set", () => {
    const record = toSessionTagCompatRecord(tag({ comment: "needs review" }));
    expect(record.comment).toBe("needs review");
  });
});
