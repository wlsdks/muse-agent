import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

export const BROWSER_ACTION_PLAN_VERSION = "muse.browser-action-plan/v1" as const;

export interface BrowserInspectEvidence {
  readonly elements: readonly Readonly<{
    readonly name: string;
    readonly ref: number;
    readonly role: string;
    readonly url?: string;
  }>[];
  readonly observedAt: string;
  readonly snapshotId: string;
  readonly source: "browser_read";
  readonly url: string;
}

export interface BrowserClickActionPlan {
  readonly action: "click";
  readonly page: Readonly<{
    observedAt: string;
    snapshotId: string;
    source: "browser_read";
    url: string;
  }>;
  readonly planId: string;
  readonly requiresFreshValidation: true;
  readonly schemaVersion: typeof BROWSER_ACTION_PLAN_VERSION;
  readonly target: Readonly<{
    name: string;
    ref: number;
    role: string;
    url?: string;
  }>;
}

export type BrowserActionPlanResult =
  | Readonly<{
      canExecute: false;
      plan: BrowserClickActionPlan;
      schemaVersion: typeof BROWSER_ACTION_PLAN_VERSION;
      status: "planned";
    }>
  | Readonly<{
      canExecute: false;
      reason: "ambiguous-ref" | "invalid-input" | "unknown-ref";
      schemaVersion: typeof BROWSER_ACTION_PLAN_VERSION;
      status: "held";
    }>;

export type BrowserActionPlanRevalidationResult =
  | Readonly<{
      canExecute: false;
      schemaVersion: typeof BROWSER_ACTION_PLAN_VERSION;
      status: "current";
      validation: Readonly<{
        planId: string;
        revalidatedAt: string;
        snapshotId: string;
        targetRef: number;
      }>;
    }>
  | Readonly<{
      canExecute: false;
      reason:
        | "ambiguous-ref"
        | "invalid-input"
        | "stale-generation"
        | "stale-page"
        | "stale-target"
        | "tampered-plan"
        | "unknown-ref";
      schemaVersion: typeof BROWSER_ACTION_PLAN_VERSION;
      status: "held";
    }>;

/**
 * Convert one exact inspect snapshot target into a reviewable click plan.
 * This is intentionally capability-free: no controller, approval gate, file,
 * network, or system dependency can be supplied, and every result keeps
 * `canExecute:false`. Task 063 must freshly revalidate the target before any
 * later executor may act.
 */
export function projectBrowserClickActionPlan(input: {
  readonly evidence: BrowserInspectEvidence;
  readonly ref: number;
}): BrowserActionPlanResult {
  try {
    const root = exactDataRecord(input, ["evidence", "ref"]);
    if (!root) return held("invalid-input");
    const ref = positiveInteger(root["ref"]);
    const evidence = parseEvidence(root["evidence"]);
    if (!ref || !evidence) return held("invalid-input");

    const matches = evidence.elements.filter((element) => element.ref === ref);
    if (new Set(evidence.elements.map((element) => element.ref)).size !== evidence.elements.length) {
      return matches.length > 1 ? held("ambiguous-ref") : held("invalid-input");
    }
    if (matches.length === 0) return held("unknown-ref");
    if (matches.length !== 1) return held("ambiguous-ref");
    const target = Object.freeze({ ...matches[0]! });
    const page = Object.freeze({
      observedAt: evidence.observedAt,
      snapshotId: evidence.snapshotId,
      source: "browser_read" as const,
      url: evidence.url
    });
    const planCore = {
      action: "click" as const,
      page,
      requiresFreshValidation: true as const,
      schemaVersion: BROWSER_ACTION_PLAN_VERSION,
      target
    };
    const planId = hashPlanCore(planCore);
    return Object.freeze({
      canExecute: false,
      plan: Object.freeze({ ...planCore, planId }),
      schemaVersion: BROWSER_ACTION_PLAN_VERSION,
      status: "planned" as const
    });
  } catch {
    return held("invalid-input");
  }
}

/**
 * Compare a capability-free plan with current inspect evidence for a later
 * executor boundary. This validates evidence only; it never grants approval or
 * carries an action callback.
 *
 * This pure contract is not yet wired into PuppeteerBrowserController, has no
 * live DOM mutation observer, and cannot make validation+execution atomic.
 * A later runtime integration must close that TOCTOU window before claiming
 * action-time stale-target protection.
 */
export function revalidateBrowserClickActionPlan(input: {
  readonly currentEvidence: BrowserInspectEvidence;
  readonly plan: BrowserClickActionPlan;
}): BrowserActionPlanRevalidationResult {
  try {
    const root = exactDataRecord(input, ["currentEvidence", "plan"]);
    if (!root) return heldRevalidation("invalid-input");
    const parsedPlan = parsePlan(root["plan"]);
    if (parsedPlan.kind === "invalid") return heldRevalidation("invalid-input");
    if (parsedPlan.kind === "tampered") return heldRevalidation("tampered-plan");
    const plan = parsedPlan.plan;
    if (hashPlanCore({
      action: plan.action,
      page: plan.page,
      requiresFreshValidation: plan.requiresFreshValidation,
      schemaVersion: plan.schemaVersion,
      target: plan.target
    }) !== plan.planId) {
      return heldRevalidation("tampered-plan");
    }
    const current = parseEvidence(root["currentEvidence"]);
    if (!current) return heldRevalidation("invalid-input");
    if (current.snapshotId !== plan.page.snapshotId) {
      return heldRevalidation("stale-generation");
    }
    if (current.url !== plan.page.url) {
      return heldRevalidation("stale-page");
    }
    if (Date.parse(current.observedAt) < Date.parse(plan.page.observedAt)) {
      return heldRevalidation("stale-generation");
    }
    const matches = current.elements.filter((element) => element.ref === plan.target.ref);
    if (matches.length === 0) return heldRevalidation("unknown-ref");
    if (matches.length !== 1) return heldRevalidation("ambiguous-ref");
    if (new Set(current.elements.map((element) => element.ref)).size !== current.elements.length) {
      return heldRevalidation("ambiguous-ref");
    }
    if (JSON.stringify(matches[0]) !== JSON.stringify(plan.target)) {
      return heldRevalidation("stale-target");
    }
    return Object.freeze({
      canExecute: false,
      schemaVersion: BROWSER_ACTION_PLAN_VERSION,
      status: "current" as const,
      validation: Object.freeze({
        planId: plan.planId,
        revalidatedAt: current.observedAt,
        snapshotId: current.snapshotId,
        targetRef: plan.target.ref
      })
    });
  } catch {
    return heldRevalidation("invalid-input");
  }
}

type ParsedPlan =
  | { readonly kind: "invalid" }
  | { readonly kind: "tampered" }
  | { readonly kind: "valid"; readonly plan: BrowserClickActionPlan };

function parsePlan(value: unknown): ParsedPlan {
  const record = exactDataRecord(value, [
    "action",
    "page",
    "planId",
    "requiresFreshValidation",
    "schemaVersion",
    "target"
  ]);
  if (!record) return { kind: "invalid" };
  if (
    record["action"] !== "click"
    || record["requiresFreshValidation"] !== true
    || record["schemaVersion"] !== BROWSER_ACTION_PLAN_VERSION
  ) {
    return { kind: "tampered" };
  }
  const planId = exactSha256(record["planId"]);
  if (!planId) return { kind: "tampered" };
  const pageRecord = exactDataRecord(record["page"], [
    "observedAt",
    "snapshotId",
    "source",
    "url"
  ]);
  const target = parseElement(record["target"]);
  if (!pageRecord || pageRecord["source"] !== "browser_read" || !target) {
    return { kind: "tampered" };
  }
  const observedAt = canonicalInstant(pageRecord["observedAt"]);
  const snapshotId = exactIdentifier(pageRecord["snapshotId"]);
  const url = exactWebUrl(pageRecord["url"]);
  if (!observedAt || !snapshotId || !url) return { kind: "tampered" };
  return {
    kind: "valid",
    plan: {
      action: "click",
      page: Object.freeze({
        observedAt,
        snapshotId,
        source: "browser_read",
        url
      }),
      planId,
      requiresFreshValidation: true,
      schemaVersion: BROWSER_ACTION_PLAN_VERSION,
      target
    }
  };
}

function hashPlanCore(value: Omit<BrowserClickActionPlan, "planId">): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function parseEvidence(value: unknown): BrowserInspectEvidence | undefined {
  const record = exactDataRecord(value, [
    "elements",
    "observedAt",
    "snapshotId",
    "source",
    "url"
  ]);
  if (!record || record["source"] !== "browser_read") return undefined;
  const elements = exactDataArray(record["elements"]);
  const observedAt = canonicalInstant(record["observedAt"]);
  const snapshotId = exactIdentifier(record["snapshotId"]);
  const url = exactWebUrl(record["url"]);
  if (!elements || !observedAt || !snapshotId || !url) return undefined;

  const parsedElements: BrowserInspectEvidence["elements"][number][] = [];
  for (const valueAtIndex of elements) {
    const element = parseElement(valueAtIndex);
    if (!element) return undefined;
    parsedElements.push(element);
  }
  return {
    elements: parsedElements,
    observedAt,
    snapshotId,
    source: "browser_read",
    url
  };
}

function parseElement(
  value: unknown
): BrowserInspectEvidence["elements"][number] | undefined {
  const record = exactDataRecord(value, ["name", "ref", "role"], ["url"]);
  if (!record) return undefined;
  const name = exactText(record["name"]);
  const ref = positiveInteger(record["ref"]);
  const role = exactText(record["role"]);
  const hasUrl = Object.hasOwn(record, "url");
  const url = hasUrl ? exactWebUrl(record["url"]) : undefined;
  if (!name || !ref || !role || (hasUrl && !url)) return undefined;
  return Object.freeze({
    name,
    ref,
    role,
    ...(url ? { url } : {})
  });
}

function exactDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || requiredKeys.some((key) => !keys.includes(key))
    || keys.some(
      (key) =>
        typeof key !== "string"
        || (!requiredKeys.includes(key) && !optionalKeys.includes(key))
    )
  ) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    output[key] = descriptor.value;
  }
  return output;
}

function exactDataArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  const expected = Array.from({ length: value.length }, (_unused, index) => index.toString());
  if (
    keys.length !== expected.length + 1
    || keys.at(-1) !== "length"
    || expected.some((key, index) => keys[index] !== key)
  ) {
    return undefined;
  }
  const output: unknown[] = [];
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    output.push(descriptor.value);
  }
  return output;
}

function exactText(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && !/\p{Cc}/u.test(value)
    ? value
    : undefined;
}

function exactIdentifier(value: unknown): string | undefined {
  const text = exactText(value);
  return text && Buffer.byteLength(text, "utf8") <= 256 ? text : undefined;
}

function exactSha256(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function canonicalInstant(value: unknown): string | undefined {
  const text = exactText(value);
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === text
    ? text
    : undefined;
}

function exactWebUrl(value: unknown): string | undefined {
  const text = exactText(value);
  if (!text) return undefined;
  const parsed = new URL(text);
  return (parsed.protocol === "https:" || parsed.protocol === "http:")
    && parsed.username.length === 0
    && parsed.password.length === 0
    && parsed.href === text
    ? text
    : undefined;
}

function held(
  reason: Extract<BrowserActionPlanResult, { status: "held" }>["reason"]
): Extract<BrowserActionPlanResult, { status: "held" }> {
  return Object.freeze({
    canExecute: false,
    reason,
    schemaVersion: BROWSER_ACTION_PLAN_VERSION,
    status: "held" as const
  });
}

function heldRevalidation(
  reason: Extract<BrowserActionPlanRevalidationResult, { status: "held" }>["reason"]
): Extract<BrowserActionPlanRevalidationResult, { status: "held" }> {
  return Object.freeze({
    canExecute: false,
    reason,
    schemaVersion: BROWSER_ACTION_PLAN_VERSION,
    status: "held" as const
  });
}
