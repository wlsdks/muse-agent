import { describe, expect, it } from "vitest";

import { actionResultLabel, objectiveStatusLabel } from "./autonomy-labels.js";

import type { Translate } from "../i18n/index.js";

// A fake translator that echoes the key, so we assert WHICH key each status maps
// to (the behavior under test) without depending on the actual copy.
const echo = ((key: string) => key) as unknown as Translate;

describe("actionResultLabel", () => {
  it("maps known results to actstatus keys", () => {
    expect(actionResultLabel("performed", echo)).toBe("actstatus.performed");
    expect(actionResultLabel("refused", echo)).toBe("actstatus.refused");
    expect(actionResultLabel("failed", echo)).toBe("actstatus.failed");
  });

  it("falls back to the raw value for an unknown result", () => {
    expect(actionResultLabel("queued", echo)).toBe("queued");
  });
});

describe("objectiveStatusLabel", () => {
  it("maps known statuses to auto.status keys", () => {
    expect(objectiveStatusLabel("active", echo)).toBe("auto.status.active");
    expect(objectiveStatusLabel("done", echo)).toBe("auto.status.done");
  });

  it("falls back to the raw value for an unknown status", () => {
    expect(objectiveStatusLabel("paused", echo)).toBe("paused");
  });
});
