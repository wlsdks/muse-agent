import { expect, it } from "vitest";

import { InMemoryAttunementGraphStore } from "./index.js";
import { runAttunementGraphStoreConformance } from "./testing.js";

it("passes the reusable store conformance contract", async () => {
  const report = await runAttunementGraphStoreConformance(
    () => new InMemoryAttunementGraphStore()
  );

  expect(report).toEqual({
    cases: [
      { name: "atomic append and idempotent replay", passed: true },
      { name: "deterministic bounded traversal", passed: true },
      { name: "recorded-time ordering", passed: true },
      { name: "forget cascade and index verification", passed: true }
    ],
    passed: true
  });
});
