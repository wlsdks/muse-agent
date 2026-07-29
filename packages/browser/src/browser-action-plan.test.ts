import { describe, expect, it } from "vitest";

import {
  BROWSER_ACTION_PLAN_VERSION,
  projectBrowserClickActionPlan,
  revalidateBrowserClickActionPlan,
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

describe("revalidateBrowserClickActionPlan", () => {
  function plan() {
    const result = projectBrowserClickActionPlan({ evidence: EVIDENCE, ref: 2 });
    if (result.status !== "planned") throw new Error("expected plan");
    return result.plan;
  }

  it("validates exact current generation, page, and target identity without granting execution", () => {
    const result = revalidateBrowserClickActionPlan({
      currentEvidence: {
        ...EVIDENCE,
        observedAt: "2026-07-29T03:00:01.000Z"
      },
      plan: plan()
    });
    expect(result).toEqual({
      canExecute: false,
      schemaVersion: BROWSER_ACTION_PLAN_VERSION,
      status: "current",
      validation: {
        planId: plan().planId,
        revalidatedAt: "2026-07-29T03:00:01.000Z",
        snapshotId: "snapshot-062",
        targetRef: 2
      }
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status === "current" && Object.isFrozen(result.validation)).toBe(true);
  });

  it.each([
    [
      "generation drift",
      { currentEvidence: { ...EVIDENCE, snapshotId: "snapshot-new" }, plan: plan() },
      "stale-generation"
    ],
    [
      "page drift",
      { currentEvidence: { ...EVIDENCE, url: "https://example.com/other" }, plan: plan() },
      "stale-page"
    ],
    [
      "older observation",
      {
        currentEvidence: { ...EVIDENCE, observedAt: "2026-07-29T02:59:59.999Z" },
        plan: plan()
      },
      "stale-generation"
    ],
    [
      "node name drift",
      {
        currentEvidence: {
          ...EVIDENCE,
          elements: [
            EVIDENCE.elements[0]!,
            { ...EVIDENCE.elements[1]!, name: "Delete account" }
          ]
        },
        plan: plan()
      },
      "stale-target"
    ],
    [
      "node role drift",
      {
        currentEvidence: {
          ...EVIDENCE,
          elements: [
            EVIDENCE.elements[0]!,
            { ...EVIDENCE.elements[1]!, role: "link" }
          ]
        },
        plan: plan()
      },
      "stale-target"
    ],
    [
      "missing node",
      {
        currentEvidence: { ...EVIDENCE, elements: [EVIDENCE.elements[0]!] },
        plan: plan()
      },
      "unknown-ref"
    ],
    [
      "duplicate node",
      {
        currentEvidence: {
          ...EVIDENCE,
          elements: [...EVIDENCE.elements, { ...EVIDENCE.elements[1]! }]
        },
        plan: plan()
      },
      "ambiguous-ref"
    ],
    [
      "tampered target",
      {
        currentEvidence: EVIDENCE,
        plan: { ...plan(), target: { ...plan().target, name: "Delete account" } }
      },
      "tampered-plan"
    ],
    [
      "tampered plan time",
      {
        currentEvidence: EVIDENCE,
        plan: {
          ...plan(),
          page: { ...plan().page, observedAt: "2026-07-29T02:59:00.000Z" }
        }
      },
      "tampered-plan"
    ],
    [
      "tampered action",
      {
        currentEvidence: EVIDENCE,
        plan: { ...plan(), action: "type" }
      },
      "tampered-plan"
    ],
    [
      "tampered source",
      {
        currentEvidence: EVIDENCE,
        plan: {
          ...plan(),
          page: { ...plan().page, source: "browser_look" }
        }
      },
      "tampered-plan"
    ],
    [
      "tampered schema",
      {
        currentEvidence: EVIDENCE,
        plan: { ...plan(), schemaVersion: "muse.browser-action-plan/v2" }
      },
      "tampered-plan"
    ],
    [
      "malformed plan hash",
      {
        currentEvidence: EVIDENCE,
        plan: { ...plan(), planId: "not-a-sha256" }
      },
      "tampered-plan"
    ],
    [
      "tampered plan with malformed current evidence",
      {
        currentEvidence: { ...EVIDENCE, hidden: true },
        plan: { ...plan(), target: { ...plan().target, name: "Delete account" } }
      },
      "tampered-plan"
    ]
  ])("holds %s before an executor boundary", (_name, input, reason) => {
    expect(revalidateBrowserClickActionPlan(input as never)).toEqual({
      canExecute: false,
      reason,
      schemaVersion: BROWSER_ACTION_PLAN_VERSION,
      status: "held"
    });
  });
});
