import { describe, expect, it } from "vitest";

import { KyselyDebugReplayCaptureStore } from "../src/debug-replay.js";

describe("KyselyDebugReplayCaptureStore", () => {
  it("uses the same deterministic ordering and limit boundary as the in-memory store", async () => {
    const observed = createListQueryObserver();
    const store = new KyselyDebugReplayCaptureStore(observed.database as never);

    await store.listDebugReplayCaptures(1.9);

    expect(observed.orderByCalls).toEqual([
      ["captured_at", "desc"],
      ["id", "asc"]
    ]);
    expect(observed.limit).toBe(1);
  });

  it.each([
    { limit: -1, expected: 0 },
    { limit: Number.NaN, expected: 50 },
    { limit: Number.POSITIVE_INFINITY, expected: 50 },
    { limit: Number.MAX_VALUE, expected: 50 }
  ])("normalizes unsafe list limit $limit", async ({ limit, expected }) => {
    const observed = createListQueryObserver();
    const store = new KyselyDebugReplayCaptureStore(observed.database as never);

    await store.listDebugReplayCaptures(limit);

    expect(observed.limit).toBe(expected);
  });
});

function createListQueryObserver() {
  const orderByCalls: Array<[string, string]> = [];
  let limit: number | undefined;

  const query = {
    orderBy(column: string, direction: string) {
      orderByCalls.push([column, direction]);
      return query;
    },
    limit(value: number) {
      limit = value;
      return {
        execute: async () => []
      };
    }
  };

  return {
    database: {
      selectFrom: () => ({
        selectAll: () => query
      })
    },
    orderByCalls,
    get limit() {
      return limit;
    }
  };
}
