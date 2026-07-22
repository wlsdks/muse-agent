import { describe, expect, it } from "vitest";

import {
  admitPersonalStatus,
  buildPersonalStatus,
  PERSONAL_STATUS_SCHEMA_VERSION,
  PERSONAL_STATUS_SOURCE_IDS,
  type PersonalStatusCard,
  type PersonalStatusResponse,
  type PersonalStatusSource
} from "./personal-status.js";

const NOW = "2026-07-22T12:00:00.000Z";
const SOURCE: PersonalStatusSource = {
  excludedCount: 0,
  id: "resident-runtime",
  includedCount: 1,
  observedAt: NOW,
  result: "available"
};
const RUNTIME: PersonalStatusCard = {
  action: { id: "inspect-runtime", target: { command: "muse daemon --status", type: "command" } },
  deadline: null,
  detail: "Heartbeat and process identity agree.",
  id: "runtime:resident",
  kind: "runtime-trust",
  observedAt: "2026-07-22T11:59:00.000Z",
  priority: 60,
  sourceId: "resident-runtime",
  status: "info",
  title: "Resident runtime verified"
};

function response(overrides: Partial<PersonalStatusResponse> = {}): PersonalStatusResponse {
  const sources = PERSONAL_STATUS_SOURCE_IDS.map((id): PersonalStatusSource => id === "resident-runtime"
    ? SOURCE
    : { excludedCount: 0, id, includedCount: 0, observedAt: NOW, result: "available" });
  return {
    cards: [RUNTIME],
    generatedAt: NOW,
    overall: "clear",
    schemaVersion: PERSONAL_STATUS_SCHEMA_VERSION,
    sources,
    ...overrides
  };
}

describe("personal-status v1 contract", () => {
  it("admits the exact top-level schema and coherent runtime card", () => {
    expect(admitPersonalStatus(response())).toEqual({ kind: "admitted", status: response() });
  });

  it("rejects the original contradictory top-level variants", () => {
    const { schemaVersion: _schema, ...withoutSchema } = response();
    expect(admitPersonalStatus(withoutSchema)).toEqual({ kind: "excluded", reason: "invalid-shape" });
    expect(admitPersonalStatus({ ...response(), guessedScore: 1 })).toEqual({ kind: "excluded", reason: "invalid-shape" });
  });

  it.each([
    [{ ...RUNTIME, action: undefined }, "invalid-card"],
    [{ ...RUNTIME, unavailableReason: "also unavailable" }, "invalid-card"],
    [{ ...RUNTIME, priority: 10 }, "invalid-card"],
    [{ ...RUNTIME, observedAt: "2026-07-22T12:00:00Z" }, "invalid-card"],
    [{ ...RUNTIME, observedAt: "2026-07-22T12:00:00.001Z" }, "invalid-card"],
    [{ ...RUNTIME, action: { id: "show-proposal-command", target: { command: "muse daemon --status", type: "command" } } }, "invalid-card"]
  ] as const)("rejects incoherent card %#", (card, reason) => {
    expect(admitPersonalStatus(response({ cards: [card as PersonalStatusCard] }))).toEqual({ kind: "excluded", reason });
  });

  it("enforces source result/error/count coherence", () => {
    const rows = response().sources;
    expect(admitPersonalStatus(response({ sources: [{ ...SOURCE, errorCode: "missing" }, ...rows.slice(1)] }))).toEqual({ kind: "excluded", reason: "invalid-source" });
    expect(admitPersonalStatus(response({ cards: [], overall: "clear", sources: [{ ...SOURCE, includedCount: 999 }, ...rows.slice(1)] }))).toEqual({ kind: "excluded", reason: "invalid-source" });
    expect(admitPersonalStatus(response({ sources: [...rows].reverse() }))).toEqual({ kind: "excluded", reason: "invalid-source" });
    expect(admitPersonalStatus(response({ sources: rows.slice(0, -1) }))).toEqual({ kind: "excluded", reason: "invalid-source" });
    const absentApprovals = rows.map((row): PersonalStatusSource => row.id === "pending-approvals"
      ? { errorCode: "missing", excludedCount: 0, id: row.id, includedCount: 0, observedAt: NOW, result: "absent" }
      : row);
    const actionableFromAbsent: PersonalStatusCard = {
      action: { id: "review-approval", target: { itemId: "laundered", review: "approval", type: "local-review" } },
      deadline: "2026-07-22T13:00:00.000Z",
      detail: "must not be admitted",
      id: "approval:laundered",
      kind: "external-approval",
      observedAt: "2026-07-22T11:00:00.000Z",
      priority: 20,
      sourceId: "pending-approvals",
      status: "attention",
      title: "Laundered approval"
    };
    expect(admitPersonalStatus(response({ cards: [actionableFromAbsent, RUNTIME], overall: "attention", sources: absentApprovals })))
      .toEqual({ kind: "excluded", reason: "invalid-source" });
  });

  it("sorts, deduplicates and derives held before attention", () => {
    const held: PersonalStatusCard = {
      action: { id: "inspect-runtime", target: { command: "muse daemon --status", type: "command" } },
      deadline: null,
      detail: "Heartbeat is stale.",
      id: "runtime:resident",
      kind: "runtime-trust",
      observedAt: NOW,
      priority: 10,
      sourceId: "resident-runtime",
      status: "held",
      title: "Muse is held"
    };
    const approval: PersonalStatusCard = {
      action: { id: "review-approval", target: { itemId: "a1", review: "approval", type: "local-review" } },
      deadline: "2026-07-22T13:00:00.000Z",
      detail: "Draft message",
      id: "approval:a1",
      kind: "external-approval",
      observedAt: "2026-07-22T11:00:00.000Z",
      priority: 20,
      sourceId: "pending-approvals",
      status: "attention",
      title: "Review draft"
    };
    const sources = response().sources.map((row) => row.id === "pending-approvals" ? { ...row, includedCount: 1 } : row);
    const built = buildPersonalStatus({ cards: [approval, RUNTIME, held], generatedAt: NOW, sources });
    expect(built.cards.map((card) => card.id)).toEqual(["runtime:resident", "approval:a1"]);
    expect(built.overall).toBe("held");
  });

  it("orders equal-priority deadlines first and uses stable observed/kind/id ties", () => {
    const approval = (id: string, deadline: string, observedAt: string): PersonalStatusCard => ({
      action: { id: "review-approval", target: { itemId: id, review: "approval", type: "local-review" } },
      deadline,
      detail: id,
      id: `approval:${id}`,
      kind: "external-approval",
      observedAt,
      priority: 20,
      sourceId: "pending-approvals",
      status: "attention",
      title: id
    });
    const sources = response({ cards: [] }).sources.map((row) => row.id === "resident-runtime"
      ? { ...row, includedCount: 0 }
      : row.id === "pending-approvals" ? { ...row, includedCount: 3 } : row);
    const built = buildPersonalStatus({
      cards: [approval("late", "2026-07-22T14:00:00.000Z", "2026-07-22T11:59:00.000Z"), approval("early-old", "2026-07-22T13:00:00.000Z", "2026-07-22T10:00:00.000Z"), approval("early-new", "2026-07-22T13:00:00.000Z", "2026-07-22T11:00:00.000Z")],
      generatedAt: NOW,
      sources
    });
    expect(built.cards.map((card) => card.id)).toEqual(["approval:early-new", "approval:early-old", "approval:late"]);
  });

  it("admits every planned kind/status variant and rejects variants outside the table", () => {
    const unavailable = (kind: PersonalStatusCard["kind"], sourceId: PersonalStatusCard["sourceId"]): PersonalStatusCard => ({
      deadline: null,
      detail: "",
      id: `source:${sourceId}`,
      kind,
      observedAt: NOW,
      priority: 10,
      sourceId,
      status: "unavailable",
      title: "Source unavailable",
      unavailableReason: "Evidence could not be read."
    });
    const cases: readonly PersonalStatusCard[] = [
      unavailable("runtime-trust", "resident-runtime"),
      unavailable("external-approval", "pending-approvals"),
      unavailable("external-proposal", "proposed-actions"),
      unavailable("continuity-feedback", "attunement"),
      unavailable("learning-review", "reconfirmation"),
      unavailable("learning-change", "user-memory"),
      unavailable("learning-change", "belief-provenance"),
      unavailable("veto", "vetoes")
    ];
    for (const card of cases) {
      const sources = response({ cards: [] }).sources.map((row): PersonalStatusSource => row.id === card.sourceId
        ? { errorCode: "missing", excludedCount: 0, id: row.id, includedCount: 0, observedAt: NOW, result: "absent" }
        : { ...row, includedCount: 0 });
      expect(admitPersonalStatus({ ...response(), cards: [card], overall: "held", sources }).kind, `${card.kind}/${card.sourceId}`).toBe("admitted");
    }
    expect(admitPersonalStatus(response({ cards: [{ ...RUNTIME, kind: "continuity-thread", status: "info" } as PersonalStatusCard] }))).toEqual({ kind: "excluded", reason: "invalid-card" });
  });
});
