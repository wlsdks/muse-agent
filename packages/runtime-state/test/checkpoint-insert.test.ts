import { describe, expect, it } from "vitest";

import type { SaveCheckpointInput } from "../src/index.js";
import { createCheckpointInsert } from "../src/kysely-stores.js";

const options = () => {
  let n = 0;
  return { now: () => new Date("2026-02-02T00:00:00Z"), idFactory: () => `cp-${n++}` };
};
const input = (overrides: Partial<SaveCheckpointInput> = {}): SaveCheckpointInput => ({
  runId: "r1",
  state: { messages: [1] },
  step: 3,
  ...overrides,
});

describe("createCheckpointInsert", () => {
  it("applies created_at/id defaults and passes run_id/state/step through", () => {
    expect(createCheckpointInsert(input(), options())).toEqual({
      created_at: new Date("2026-02-02T00:00:00Z"),
      id: "cp-0",
      run_id: "r1",
      state: { messages: [1] },
      step: 3,
    });
  });

  it("honours an explicit id and createdAt, preserving step 0", () => {
    expect(
      createCheckpointInsert(input({ id: "fixed", createdAt: new Date("2025-01-01T00:00:00Z"), step: 0 }), options()),
    ).toMatchObject({ id: "fixed", created_at: new Date("2025-01-01T00:00:00Z"), step: 0 });
  });
});
