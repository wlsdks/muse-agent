import { describe, expect, it } from "vitest";

import {
  BROWSER_ACTION_PLAN_VERSION,
  projectBrowserClickActionPlan,
  type BrowserInspectEvidence
} from "./browser-action-plan.js";

const EVIDENCE: BrowserInspectEvidence = {
  elements: [
    { name: "Account settings", ref: 1, role: "link", url: "https://example.com/settings" },
    { name: "Save", ref: 2, role: "button" }
  ],
  observedAt: "2026-07-29T03:00:00.000Z",
  snapshotId: "snapshot-062",
  source: "browser_read",
  url: "https://example.com/profile"
};

describe("projectBrowserClickActionPlan", () => {
  it("projects one exact ref into a frozen, capability-free review plan", () => {
    const source = structuredClone(EVIDENCE);
    const before = structuredClone(source);
    const effects = { click: 0, download: 0, system: 0, type: 0, upload: 0 };
    const result = projectBrowserClickActionPlan({ evidence: source, ref: 2 });

    expect(result).toMatchObject({
      canExecute: false,
      plan: {
        action: "click",
        page: {
          observedAt: "2026-07-29T03:00:00.000Z",
          snapshotId: "snapshot-062",
          source: "browser_read",
          url: "https://example.com/profile"
        },
        requiresFreshValidation: true,
        schemaVersion: BROWSER_ACTION_PLAN_VERSION,
        target: { name: "Save", ref: 2, role: "button" }
      },
      schemaVersion: BROWSER_ACTION_PLAN_VERSION,
      status: "planned"
    });
    expect(result.status === "planned" && result.plan.planId).toMatch(/^[a-f0-9]{64}$/u);
    expect(result).not.toHaveProperty("execute");
    expect(result.status === "planned" && result.plan).not.toHaveProperty("execute");
    expect(effects).toEqual({ click: 0, download: 0, system: 0, type: 0, upload: 0 });
    expect(source).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status === "planned" && Object.isFrozen(result.plan)).toBe(true);
    expect(result.status === "planned" && Object.isFrozen(result.plan.page)).toBe(true);
    expect(result.status === "planned" && Object.isFrozen(result.plan.target)).toBe(true);
  });

  it.each([
    ["unknown ref", { evidence: EVIDENCE, ref: 99 }, "unknown-ref"],
    [
      "duplicate ref",
      {
        evidence: {
          ...EVIDENCE,
          elements: [...EVIDENCE.elements, { name: "Other Save", ref: 2, role: "button" }]
        },
        ref: 2
      },
      "ambiguous-ref"
    ],
    [
      "unrelated duplicate ref",
      {
        evidence: {
          ...EVIDENCE,
          elements: [
            ...EVIDENCE.elements,
            { name: "Duplicate account", ref: 1, role: "link" }
          ]
        },
        ref: 2
      },
      "invalid-input"
    ],
    ["zero ref", { evidence: EVIDENCE, ref: 0 }, "invalid-input"],
    [
      "noncanonical time",
      { evidence: { ...EVIDENCE, observedAt: "2026-07-29T03:00:00Z" }, ref: 2 },
      "invalid-input"
    ],
    [
      "credential URL",
      { evidence: { ...EVIDENCE, url: "https://user:pass@example.com/profile" }, ref: 2 },
      "invalid-input"
    ],
    [
      "explicit undefined optional URL",
      {
        evidence: {
          ...EVIDENCE,
          elements: [{ name: "Save", ref: 2, role: "button", url: undefined }]
        },
        ref: 2
      },
      "invalid-input"
    ]
  ])("holds %s without any executable capability", (_name, input, reason) => {
    expect(projectBrowserClickActionPlan(input as never)).toEqual({
      canExecute: false,
      reason,
      schemaVersion: BROWSER_ACTION_PLAN_VERSION,
      status: "held"
    });
  });

  it("fails closed on proxies, getters, hidden fields, and sparse arrays without traps", () => {
    let trapCalls = 0;
    let getterCalls = 0;
    const proxiedElements = new Proxy([...EVIDENCE.elements], {
      getPrototypeOf(target) {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      }
    });
    const getterEvidence = {};
    for (const [key, value] of Object.entries(EVIDENCE)) {
      Object.defineProperty(getterEvidence, key, {
        enumerable: true,
        get() {
          getterCalls += 1;
          return value;
        }
      });
    }
    const sparseElements = [...EVIDENCE.elements, { name: "Other", ref: 3, role: "button" }];
    delete sparseElements[1];
    const cases = [
      { evidence: { ...EVIDENCE, elements: proxiedElements }, ref: 2 },
      { evidence: getterEvidence, ref: 2 },
      { evidence: { ...EVIDENCE, hidden: true }, ref: 2 },
      { evidence: { ...EVIDENCE, elements: sparseElements }, ref: 2 }
    ];
    for (const input of cases) {
      expect(projectBrowserClickActionPlan(input as never)).toEqual({
        canExecute: false,
        reason: "invalid-input",
        schemaVersion: BROWSER_ACTION_PLAN_VERSION,
        status: "held"
      });
    }
    expect(trapCalls).toBe(0);
    expect(getterCalls).toBe(0);
  });

  it("exports a stable versioned contract", () => {
    expect(BROWSER_ACTION_PLAN_VERSION).toBe("muse.browser-action-plan/v1");
  });
});
