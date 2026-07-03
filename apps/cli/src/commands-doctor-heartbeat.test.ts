import { describe, expect, it } from "vitest";

import { heartbeatStatusToCheckStatus, proactiveHeartbeatCheck } from "./commands-doctor-heartbeat.js";

const nowMs = Date.parse("2026-07-01T10:10:00Z");
const mark = (iso: string) => ({ at: iso, pid: 1 });

describe("proactiveHeartbeatCheck — doctor surfacing per heartbeat state", () => {
  it("healthy (alive+fired fresh) → ok", () => {
    const check = proactiveHeartbeatCheck(
      { alive: mark("2026-07-01T10:09:30Z"), fired: mark("2026-07-01T10:09:31Z") },
      { nowMs }
    );
    expect(check).toMatchObject({ name: "proactive heartbeat", status: "ok" });
  });

  it("failing (alive fresh, fired stale) → warn", () => {
    const check = proactiveHeartbeatCheck(
      { alive: mark("2026-07-01T10:09:30Z"), fired: mark("2026-07-01T09:40:00Z") },
      { nowMs }
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/failing/i);
  });

  it("dead (alive stale) → warn", () => {
    const check = proactiveHeartbeatCheck(
      { alive: mark("2026-07-01T09:00:00Z"), fired: mark("2026-07-01T09:00:00Z") },
      { nowMs }
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/stopped/i);
  });

  it("unknown (no heartbeat — daemon never ran) → ok, no false alarm", () => {
    const check = proactiveHeartbeatCheck({}, { nowMs });
    expect(check.status).toBe("ok");
  });
});

describe("heartbeatStatusToCheckStatus", () => {
  it("maps every status", () => {
    expect(heartbeatStatusToCheckStatus("healthy")).toBe("ok");
    expect(heartbeatStatusToCheckStatus("unknown")).toBe("ok");
    expect(heartbeatStatusToCheckStatus("failing")).toBe("warn");
    expect(heartbeatStatusToCheckStatus("dead")).toBe("warn");
  });
});
