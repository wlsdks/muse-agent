/**
 * Page-mutating browser tools: click, type, fill_form, upload. Every one is
 * approval-gated (draft-first per outbound-safety.md) and budget-capped via
 * BrowserActionGuard. Imports its shared contract from
 * browser-tool-primitives.js (a leaf), never from the browser-tools.js hub.
 */

import { createHash } from "node:crypto";

import { errorMessage, type JsonObject, type JsonValue } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import {
  type BrowserController,
  type BrowserUploadTargetIdentity,
  type PageSnapshot
} from "./controller.js";
import { errorResult, resolveGateDecision, resolveTarget, snapshotToJson, statusFields, type BrowserActionDraft, type BrowserApprovalGate, type ResolveResult } from "./browser-tool-primitives.js";
import type {
  ClaimPendingDialogInput,
  PendingDialogDecision,
  PendingDialogIdentity
} from "./pending-dialog-coordinator.js";
import type {
  PendingPuppeteerClickResult,
  PendingPuppeteerDialogDecisionResult
} from "./puppeteer-controller.js";

export interface BrowserActionGuard {
  /** Consume one action from the per-task budget; refuses (allowed:false) once the cap is hit. */
  tryConsume(): { readonly allowed: boolean; readonly refusal?: string; readonly warning?: string; readonly label: string };
}

export interface BrowserActToolDeps {
  readonly controller: BrowserController;
  readonly approvalGate: BrowserApprovalGate;
  /** Opt-in controller-specific path; absent keeps the legacy fail-close click contract. */
  readonly pendingDialogController?: PendingDialogBrowserController;
  /** Optional per-task action budget shared across click/type/fill. Absent ⇒ unbounded (byte-identical to pre-budget behavior). */
  readonly actionBudget?: BrowserActionGuard;
}

export interface PendingDialogBrowserController extends BrowserController {
  clickWithPendingDialog(ref: number): Promise<PendingPuppeteerClickResult>;
  decidePendingDialog(input: ClaimPendingDialogInput): Promise<PendingPuppeteerDialogDecisionResult>;
}

export interface BrowserDialogDecisionToolDeps {
  readonly approvalGate: BrowserApprovalGate;
  readonly controller: PendingDialogBrowserController;
}

function authorityReceipt(
  draft: BrowserActionDraft,
  status: "performed" | "refused" | "failed" | "held"
): JsonObject {
  return {
    action: draft.action,
    payloadDigest: createHash("sha256").update(JSON.stringify(draft), "utf8").digest("hex"),
    schemaVersion: "muse.browser-authority-receipt/v1",
    status
  };
}

export function createBrowserClickTool(deps: BrowserActToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Click something on the page in Muse's browser. Just say WHAT to click in `target` — the link text " +
        "or button label — and Muse finds it; e.g. target 'Sign in', 'Add to cart', 'the first result'. Use " +
        "to follow a link or press a button. The user MUST confirm before Muse clicks (a click can submit a " +
        "form or change something on a site); absent confirmation nothing happens. If the page then raises a " +
        "confirm/prompt, Muse returns exact pending authority for a separate browser_dialog_decide approval.",
      domain: "browser",
      groundedArgs: ["target"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          ref: { description: "Advanced: exact element ref from a prior snapshot. Prefer `target` instead.", type: "number" },
          target: { description: "What to click — the visible link text or button label, e.g. 'Sign in' or 'Add to cart'.", type: "string" }
        },
        required: ["target"],
        type: "object"
      },
      keywords: ["browser", "click", "클릭", "press", "눌러", "button", "버튼", "link", "링크", "브라우저"],
      name: "browser_click",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const budget = deps.actionBudget?.tryConsume();
      if (budget && !budget.allowed) {
        return { clicked: false, reason: budget.refusal ?? "browser action budget for this task is exhausted", actionsUsed: budget.label };
      }
      let resolved: ResolveResult;
      try {
        resolved = await resolveTarget(deps.controller, args, "click");
      } catch (cause) {
        return { clicked: false, ...errorResult(cause) };
      }
      if ("error" in resolved) {
        return { clicked: false, ...resolved.error };
      }
      const draft: BrowserActionDraft = { action: "click", target: resolved.label, url: deps.controller.currentUrl() };
      const decision = await resolveGateDecision(deps.approvalGate, draft);
      if (!decision.approved) {
        return { clicked: false, reason: decision.reason };
      }
      try {
        if (deps.pendingDialogController) {
          const outcome = await deps.pendingDialogController.clickWithPendingDialog(resolved.ref);
          if (outcome.status === "pending") {
            return {
              clicked: true,
              dialog: pendingIdentityJson(outcome.dialog),
              status: "pending",
              ...(budget
                ? {
                    actionsUsed: budget.label,
                    ...(budget.warning ? { budgetWarning: budget.warning } : {})
                  }
                : {})
            };
          }
          return {
            clicked: true,
            status: "completed",
            ...snapshotToJson(outcome.snapshot),
            ...statusFields(outcome.snapshot),
            ...(budget ? { actionsUsed: budget.label, ...(budget.warning ? { budgetWarning: budget.warning } : {}) } : {})
          };
        }
        const snapshot = await deps.controller.click(resolved.ref);
        return {
          clicked: true,
          ...snapshotToJson(snapshot),
          ...statusFields(snapshot),
          ...(budget ? { actionsUsed: budget.label, ...(budget.warning ? { budgetWarning: budget.warning } : {}) } : {})
        };
      } catch (cause) {
        return { clicked: false, ...errorResult(cause) };
      }
    }
  };
}

export function createBrowserDialogDecisionTool(
  deps: BrowserDialogDecisionToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Accept or dismiss one exact pending browser confirm/prompt. The earlier browser_click approval does " +
        "NOT approve this separate execute-risk decision; every identity field and prompt response is rebound " +
        "and shown to the user before the live dialog is touched.",
      domain: "browser",
      inputSchema: {
        additionalProperties: false,
        properties: {
          decision: {
            description: "Exact choice: accept or dismiss.",
            enum: ["accept", "dismiss"],
            type: "string"
          },
          dialogId: { description: "Opaque dialogId returned by browser_click.", type: "string" },
          generation: { description: "Exact positive generation returned by browser_click.", type: "number" },
          message: { description: "Exact page dialog message returned by browser_click.", type: "string" },
          pageTargetId: { description: "Exact pageTargetId returned by browser_click.", type: "string" },
          pageUrl: { description: "Exact pageUrl returned by browser_click.", type: "string" },
          promptDefaultValue: {
            description: "Exact prompt default returned by browser_click; prompts only.",
            type: "string"
          },
          promptResponse: {
            description: "Exact text to submit; required only when accepting a prompt.",
            type: "string"
          },
          sessionIncarnation: {
            description: "Exact sessionIncarnation returned by browser_click.",
            type: "string"
          },
          type: {
            description: "Exact dialog type returned by browser_click.",
            enum: ["confirm", "prompt"],
            type: "string"
          }
        },
        required: [
          "dialogId",
          "sessionIncarnation",
          "pageTargetId",
          "generation",
          "type",
          "message",
          "pageUrl",
          "decision"
        ],
        type: "object"
      },
      keywords: [
        "browser",
        "dialog",
        "confirm",
        "prompt",
        "accept",
        "dismiss",
        "확인",
        "취소",
        "브라우저"
      ],
      name: "browser_dialog_decide",
      risk: "execute"
    },
    execute: async (args, context): Promise<JsonObject> => {
      const claimantUserId = exactNonEmpty(context.userId);
      const claimantRunId = exactNonEmpty(context.runId);
      if (!claimantUserId || !claimantRunId) {
        return {
          decided: false,
          reason: "browser_dialog_decide requires current runId and userId authority"
        };
      }
      let parsed: ReturnType<typeof parsePendingDialogDecision>;
      try {
        parsed = parsePendingDialogDecision(args);
      } catch {
        return {
          decided: false,
          reason: "browser_dialog_decide requires a safe own-property JSON object"
        };
      }
      if (!parsed.ok) return { decided: false, reason: parsed.reason };
      const draft: BrowserActionDraft = {
        action: "dialog-decision",
        dialog: parsed.identity,
        dialogDecision: parsed.decision,
        target: `${parsed.identity.type} dialog`,
        url: parsed.identity.pageUrl
      };
      const approval = await resolveGateDecision(deps.approvalGate, draft);
      if (!approval.approved) {
        return { decided: false, reason: approval.reason };
      }
      const claimantId = `tool:${claimantUserId}:${claimantRunId}`;
      const result = await deps.controller.decidePendingDialog({
        claimantId,
        decision: parsed.decision,
        identity: parsed.identity
      });
      if (!result.ok) {
        return {
          decided: false,
          reason: result.reason,
          ...(result.receipt ? { receipt: receiptJson(result.receipt) } : {})
        };
      }
      if (!receiptMatchesRequest(result.receipt, claimantId, parsed.identity, parsed.decision)) {
        return {
          decided: false,
          reason: "browser dialog controller returned a mismatched decision receipt"
        };
      }
      return {
        decided: true,
        receipt: receiptJson(result.receipt),
        status: "acknowledged",
        ...snapshotToJson(result.snapshot),
        ...statusFields(result.snapshot)
      };
    }
  };
}

const DIALOG_DECISION_KEYS = new Set([
  "decision",
  "dialogId",
  "generation",
  "message",
  "pageTargetId",
  "pageUrl",
  "promptDefaultValue",
  "promptResponse",
  "sessionIncarnation",
  "type"
]);
const REQUIRED_DIALOG_DECISION_KEYS = [
  "decision",
  "dialogId",
  "generation",
  "message",
  "pageTargetId",
  "pageUrl",
  "sessionIncarnation",
  "type"
] as const;
const OPTIONAL_DIALOG_DECISION_KEYS = [
  "promptDefaultValue",
  "promptResponse"
] as const;

function parsePendingDialogDecision(args: JsonObject):
  | {
      readonly ok: true;
      readonly decision: PendingDialogDecision;
      readonly identity: PendingDialogIdentity;
    }
  | { readonly ok: false; readonly reason: string } {
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: "browser_dialog_decide requires an own-property JSON object" };
  }
  const reflected = Reflect.ownKeys(args);
  if (
    reflected.some((key) =>
      typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(args, key)
    )
  ) {
    return { ok: false, reason: "browser_dialog_decide requires enumerable string keys only" };
  }
  const ownKeys = reflected as string[];
  const unknown = ownKeys.find((key) => !DIALOG_DECISION_KEYS.has(key));
  if (unknown) return { ok: false, reason: `browser_dialog_decide does not accept '${unknown}'` };
  if (REQUIRED_DIALOG_DECISION_KEYS.some((key) => !Object.hasOwn(args, key))) {
    return { ok: false, reason: "browser_dialog_decide requires every identity field as an own property" };
  }
  if (
    OPTIONAL_DIALOG_DECISION_KEYS.some((key) =>
      Object.hasOwn(args, key) && args[key] === undefined
    )
  ) {
    return { ok: false, reason: "browser_dialog_decide optional fields must be absent or exact strings" };
  }
  const dialogId = exactNonEmpty(args["dialogId"]);
  const sessionIncarnation = exactNonEmpty(args["sessionIncarnation"]);
  const pageTargetId = exactNonEmpty(args["pageTargetId"]);
  const generation = args["generation"];
  const type = args["type"];
  const message = args["message"];
  const pageUrl = exactNonEmpty(args["pageUrl"]);
  const choice = args["decision"];
  if (
    !dialogId
    || !sessionIncarnation
    || !pageTargetId
    || !Number.isSafeInteger(generation)
    || (generation as number) <= 0
    || (type !== "confirm" && type !== "prompt")
    || typeof message !== "string"
    || !pageUrl
    || (choice !== "accept" && choice !== "dismiss")
  ) {
    return { ok: false, reason: "browser_dialog_decide requires one exact pending dialog identity and decision" };
  }
  const promptDefaultValue = args["promptDefaultValue"];
  const promptResponse = args["promptResponse"];
  if (
    (type === "prompt" && typeof promptDefaultValue !== "string")
    || (type === "confirm" && promptDefaultValue !== undefined)
  ) {
    return { ok: false, reason: "promptDefaultValue must be present only for prompt dialogs" };
  }
  if (
    (choice === "accept" && type === "prompt" && typeof promptResponse !== "string")
    || ((choice === "dismiss" || type === "confirm") && promptResponse !== undefined)
  ) {
    return {
      ok: false,
      reason: "promptResponse is required only when accepting a prompt dialog"
    };
  }
  const identity: PendingDialogIdentity = Object.freeze({
    dialogId,
    generation: generation as number,
    message,
    pageTargetId,
    pageUrl,
    ...(type === "prompt" ? { promptDefaultValue: promptDefaultValue as string } : {}),
    sessionIncarnation,
    type
  });
  const decision: PendingDialogDecision = Object.freeze(choice === "accept"
    ? {
        kind: "accept" as const,
        ...(type === "prompt" ? { promptResponse: promptResponse as string } : {})
      }
    : { kind: "dismiss" as const });
  return { decision, identity, ok: true };
}

function exactNonEmpty(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : undefined;
}

function pendingIdentityJson(identity: PendingDialogIdentity): JsonObject {
  return {
    dialogId: identity.dialogId,
    generation: identity.generation,
    message: identity.message,
    pageTargetId: identity.pageTargetId,
    pageUrl: identity.pageUrl,
    ...(identity.promptDefaultValue !== undefined
      ? { promptDefaultValue: identity.promptDefaultValue }
      : {}),
    sessionIncarnation: identity.sessionIncarnation,
    type: identity.type
  };
}

function receiptJson(
  receipt: Extract<PendingPuppeteerDialogDecisionResult, { readonly ok: true }>["receipt"]
): JsonObject {
  return {
    claimantId: receipt.claimantId,
    decision: receipt.decision.kind === "accept"
      ? {
          kind: "accept",
          ...(receipt.decision.promptResponse !== undefined
            ? { promptResponse: receipt.decision.promptResponse }
            : {})
        }
      : { kind: "dismiss" },
    identity: pendingIdentityJson(receipt.identity),
    schemaVersion: receipt.schemaVersion,
    status: receipt.status
  };
}

function receiptMatchesRequest(
  receipt: Extract<PendingPuppeteerDialogDecisionResult, { readonly ok: true }>["receipt"],
  claimantId: string,
  identity: PendingDialogIdentity,
  decision: PendingDialogDecision
): boolean {
  return receipt.schemaVersion === "muse.browser-dialog-decision-receipt/v1"
    && receipt.status === "acknowledged"
    && receipt.claimantId === claimantId
    && receipt.identity.dialogId === identity.dialogId
    && receipt.identity.generation === identity.generation
    && receipt.identity.message === identity.message
    && receipt.identity.pageTargetId === identity.pageTargetId
    && receipt.identity.pageUrl === identity.pageUrl
    && receipt.identity.promptDefaultValue === identity.promptDefaultValue
    && receipt.identity.sessionIncarnation === identity.sessionIncarnation
    && receipt.identity.type === identity.type
    && receipt.decision.kind === decision.kind
    && (receipt.decision.kind !== "accept"
      || (decision.kind === "accept"
        && receipt.decision.promptResponse === decision.promptResponse));
}

export function createBrowserTypeTool(deps: BrowserActToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Type text into a field on the page open in Muse's browser. '검색창에 X 입력하고 검색해줘' / 'type X " +
        "into the search box' means THIS tool — never browser_open (there is no URL to open; the field is on " +
        "the current page). Say WHICH field in `target` — its label or placeholder — and Muse finds it; set " +
        "`submit` true to request a SECOND confirmation before Enter — e.g. target 'search', text " +
        "'wireless mouse', submit true. Typing approval never authorizes submission. " +
        "Dropdowns too: put the option to choose in `text` (target 'Country', text 'Korea'). " +
        "The user MUST confirm before Muse types (it can submit a form / post to a site); absent " +
        "confirmation nothing happens.",
      domain: "browser",
      groundedArgs: ["target", "text"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          ref: { description: "Advanced: exact field ref from a prior snapshot. Prefer `target` instead.", type: "number" },
          submit: { description: "true to ask for a separate final confirmation before pressing Enter. Default false.", type: "boolean" },
          target: { description: "Which field — its label or placeholder, e.g. 'search box' or 'Email'.", type: "string" },
          text: { description: "The text to type, e.g. 'wireless headphones'.", type: "string" }
        },
        required: ["target", "text"],
        type: "object"
      },
      keywords: ["browser", "type", "입력", "fill", "검색창", "search box", "form", "폼", "enter", "브라우저"],
      name: "browser_type",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const budget = deps.actionBudget?.tryConsume();
      if (budget && !budget.allowed) {
        return { reason: budget.refusal ?? "browser action budget for this task is exhausted", typed: false, actionsUsed: budget.label };
      }
      const text = typeof args["text"] === "string" ? args["text"] : "";
      if (text.length === 0) {
        return { reason: "browser_type requires non-empty 'text'", typed: false };
      }
      const submit = args["submit"] === true;
      let resolved: ResolveResult;
      try {
        resolved = await resolveTarget(deps.controller, args, "type");
      } catch (cause) {
        return { typed: false, ...errorResult(cause) };
      }
      if ("error" in resolved) {
        return { typed: false, ...resolved.error };
      }
      const draft: BrowserActionDraft = Object.freeze({
        action: "type",
        target: resolved.label,
        text,
        url: deps.controller.currentUrl()
      });
      const decision = await resolveGateDecision(deps.approvalGate, draft);
      if (!decision.approved) {
        return { reason: decision.reason, typed: false };
      }
      let snapshot: PageSnapshot;
      try {
        snapshot = await deps.controller.type(resolved.ref, text, false);
      } catch (cause) {
        return {
          authorityReceipts: { fill: authorityReceipt(draft, "failed") },
          typed: "unknown",
          ...errorResult(cause)
        };
      }
      const typeReceipt = authorityReceipt(draft, "performed");
      if (!submit) {
        return {
          authorityReceipts: { fill: typeReceipt },
          typed: true,
          ...snapshotToJson(snapshot),
          ...statusFields(snapshot),
          ...(budget ? { actionsUsed: budget.label, ...(budget.warning ? { budgetWarning: budget.warning } : {}) } : {})
        };
      }
      const submitDraft: BrowserActionDraft = Object.freeze({
        action: "submit",
        target: resolved.label,
        text,
        url: deps.controller.currentUrl()
      });
      if (submitDraft.url !== draft.url) {
        return {
          authorityReceipts: {
            fill: typeReceipt,
            submit: authorityReceipt(submitDraft, "held")
          },
          reason: "page changed after typing; inspect again before submit",
          submitted: false,
          typed: true
        };
      }
      const submitBudget = deps.actionBudget?.tryConsume();
      if (submitBudget && !submitBudget.allowed) {
        return {
          actionsUsed: submitBudget.label,
          authorityReceipts: {
            fill: typeReceipt,
            submit: authorityReceipt(submitDraft, "held")
          },
          reason: submitBudget.refusal ?? "browser action budget is exhausted before submit",
          submitted: false,
          typed: true
        };
      }
      const submitDecision = await resolveGateDecision(deps.approvalGate, submitDraft);
      if (!submitDecision.approved) {
        return {
          authorityReceipts: {
            fill: typeReceipt,
            submit: authorityReceipt(submitDraft, "refused")
          },
          reason: submitDecision.reason,
          submitted: false,
          typed: true
        };
      }
      if (deps.controller.currentUrl() !== submitDraft.url) {
        return {
          authorityReceipts: {
            fill: typeReceipt,
            submit: authorityReceipt(submitDraft, "held")
          },
          reason: "page changed during submit approval; inspect again before submit",
          submitted: false,
          typed: true
        };
      }
      try {
        snapshot = await deps.controller.pressKey("Enter");
      } catch (cause) {
        return {
          authorityReceipts: {
            fill: typeReceipt,
            submit: authorityReceipt(submitDraft, "failed")
          },
          submitted: false,
          typed: true,
          ...errorResult(cause)
        };
      }
      return {
        authorityReceipts: {
          fill: typeReceipt,
          submit: authorityReceipt(submitDraft, "performed")
        },
        submitted: true,
        typed: true,
        ...snapshotToJson(snapshot),
        ...statusFields(snapshot),
        ...(submitBudget
          ? {
              actionsUsed: submitBudget.label,
              ...(submitBudget.warning ? { budgetWarning: submitBudget.warning } : {})
            }
          : {})
      };
    }
  };
}

interface FillFieldInput {
  readonly target: string;
  readonly value: string;
}

/**
 * Parse + validate the `fields` argument into typed {target, value} pairs.
 * Returns an error envelope (never a partial list) if the shape is wrong or
 * fewer than two fields are given — a one-field "form" is browser_type's job,
 * and a malformed list must NOT reach the resolve/fill stage half-built.
 */
function parseFillFields(raw: JsonValue | undefined): { readonly fields: readonly FillFieldInput[] } | { readonly error: JsonObject } {
  if (!Array.isArray(raw)) {
    return { error: { reason: "browser_fill_form requires 'fields': a list of {target, value} pairs, e.g. [{\"target\":\"Email\",\"value\":\"a@b.com\"},{\"target\":\"Password\",\"value\":\"x\"}]" } };
  }
  const parsed: FillFieldInput[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    const target = entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as JsonObject)["target"] === "string" ? ((entry as JsonObject)["target"] as string).trim() : "";
    const value = entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as JsonObject)["value"] === "string" ? ((entry as JsonObject)["value"] as string) : "";
    if (target.length === 0) {
      return { error: { reason: `field ${i.toString()} is missing a 'target' (the field label, e.g. 'Email')` } };
    }
    if (value.length === 0) {
      return { error: { reason: `field "${target}" is missing a non-empty 'value'` } };
    }
    parsed.push({ target, value });
  }
  if (parsed.length < 2) {
    return { error: { reason: "browser_fill_form fills 2+ fields at once — for a single field use browser_type" } };
  }
  return { fields: parsed };
}

export function createBrowserFillFormTool(deps: BrowserActToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Fill SEVERAL fields of a form on the page open in Muse's browser in ONE go — pass `fields`, a list " +
        "of {target, value} pairs (each `target` is the field's label/placeholder, `value` is what to type " +
        "into it). Set `submit` true to press Enter after the last field. Use when the user gives 2+ field " +
        "values for one form at once — a login (email + password), a sign-up, a checkout / address form — " +
        "e.g. 'log in with email a@b.com and password hunter2', '이름·이메일·전화번호 한 번에 채워줘'. Do NOT use " +
        "for a SINGLE field (use browser_type) or to click a button (use browser_click). The user MUST " +
        "confirm the full field list before filling. If `submit` is true, Muse asks a SECOND confirmation " +
        "showing the same payload before Enter; fill approval alone never submits.",
      domain: "browser",
      inputSchema: {
        additionalProperties: false,
        properties: {
          fields: {
            description: "The fields to fill, each {target, value} — e.g. [{\"target\":\"Email\",\"value\":\"a@b.com\"},{\"target\":\"Password\",\"value\":\"hunter2\"}]. Give 2 or more.",
            items: {
              additionalProperties: false,
              properties: {
                target: { description: "Which field — its label or placeholder, e.g. 'Email' or 'First name'.", type: "string" },
                value: { description: "The text to type into that field, e.g. 'a@b.com'.", type: "string" }
              },
              required: ["target", "value"],
              type: "object"
            },
            minItems: 2,
            type: "array"
          },
          submit: { description: "true to ask for a separate final confirmation before pressing Enter after filling. Default false.", type: "boolean" }
        },
        required: ["fields"],
        type: "object"
      },
      keywords: ["browser", "form", "폼", "fill", "채워", "login", "로그인", "signup", "가입", "checkout", "결제", "fields", "입력", "브라우저"],
      name: "browser_fill_form",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const budget = deps.actionBudget?.tryConsume();
      if (budget && !budget.allowed) {
        return { filled: false, reason: budget.refusal ?? "browser action budget for this task is exhausted", actionsUsed: budget.label };
      }
      const parsed = parseFillFields(args["fields"]);
      if ("error" in parsed) {
        return { filled: false, ...parsed.error };
      }
      const submit = args["submit"] === true;
      // Resolve EVERY field FIRST, before any approval or fill. If a single
      // target is unfound / ambiguous / not a text field, fail closed: zero
      // type calls, no partial fill (outbound-safety — a confirmed login that
      // only typed the email and stranded the password is a wrong external
      // effect). Surface WHICH field failed so the model retargets just it.
      const resolved: Array<{ readonly ref: number; readonly label: string; readonly value: string }> = [];
      for (const field of parsed.fields) {
        let result: ResolveResult;
        try {
          result = await resolveTarget(deps.controller, { target: field.target }, "type");
        } catch (cause) {
          return { filled: false, field: field.target, ...errorResult(cause) };
        }
        if ("error" in result) {
          return { filled: false, field: field.target, ...result.error };
        }
        resolved.push({ label: result.label, ref: result.ref, value: field.value });
      }
      const draftFields = Object.freeze(
        resolved.map((entry) => Object.freeze({ target: entry.label, value: entry.value }))
      );
      const draft: BrowserActionDraft = Object.freeze({
        action: "fill",
        fields: draftFields,
        target: `${resolved.length.toString()} fields`,
        url: deps.controller.currentUrl()
      });
      const decision = await resolveGateDecision(deps.approvalGate, draft);
      if (!decision.approved) {
        return { filled: false, reason: decision.reason };
      }
      let snapshot: PageSnapshot | undefined;
      let fieldsCompleted = 0;
      for (let i = 0; i < resolved.length; i += 1) {
        const entry = resolved[i]!;
        try {
          // Filling and submission are different authorities. Every field is
          // typed with submit=false; an optional Enter happens only after a
          // second exact-payload approval below.
          snapshot = await deps.controller.type(entry.ref, entry.value, false);
          fieldsCompleted += 1;
        } catch (cause) {
          return {
            authorityReceipts: { fill: authorityReceipt(draft, "failed") },
            effectStatus: fieldsCompleted === 0 ? "unknown" : "partial",
            filled: false,
            fields: resolved.length,
            fieldsCompleted,
            ...errorResult(cause)
          };
        }
      }
      const fillReceipt = authorityReceipt(draft, "performed");
      if (!submit) {
        return {
          authorityReceipts: { fill: fillReceipt },
          filled: true,
          fields: resolved.length,
          ...(snapshot ? { ...snapshotToJson(snapshot), ...statusFields(snapshot) } : {}),
          ...(budget ? { actionsUsed: budget.label, ...(budget.warning ? { budgetWarning: budget.warning } : {}) } : {})
        };
      }
      const submitDraft: BrowserActionDraft = Object.freeze({
        action: "submit",
        fields: draftFields,
        target: `${resolved.length.toString()} fields`,
        url: deps.controller.currentUrl()
      });
      if (submitDraft.url !== draft.url) {
        return {
          authorityReceipts: {
            fill: fillReceipt,
            submit: authorityReceipt(submitDraft, "held")
          },
          filled: true,
          fields: resolved.length,
          reason: "page changed after filling; inspect again before submit",
          submitted: false
        };
      }
      const submitBudget = deps.actionBudget?.tryConsume();
      if (submitBudget && !submitBudget.allowed) {
        return {
          actionsUsed: submitBudget.label,
          authorityReceipts: {
            fill: fillReceipt,
            submit: authorityReceipt(submitDraft, "held")
          },
          filled: true,
          fields: resolved.length,
          reason: submitBudget.refusal ?? "browser action budget is exhausted before submit",
          submitted: false
        };
      }
      const submitDecision = await resolveGateDecision(deps.approvalGate, submitDraft);
      if (!submitDecision.approved) {
        return {
          authorityReceipts: {
            fill: fillReceipt,
            submit: authorityReceipt(submitDraft, "refused")
          },
          filled: true,
          fields: resolved.length,
          reason: submitDecision.reason,
          submitted: false
        };
      }
      if (deps.controller.currentUrl() !== submitDraft.url) {
        return {
          authorityReceipts: {
            fill: fillReceipt,
            submit: authorityReceipt(submitDraft, "held")
          },
          filled: true,
          fields: resolved.length,
          reason: "page changed during submit approval; inspect again before submit",
          submitted: false
        };
      }
      try {
        snapshot = await deps.controller.pressKey("Enter");
      } catch (cause) {
        return {
          authorityReceipts: {
            fill: fillReceipt,
            submit: authorityReceipt(submitDraft, "failed")
          },
          filled: true,
          fields: resolved.length,
          submitted: false,
          ...errorResult(cause)
        };
      }
      return {
        authorityReceipts: {
          fill: fillReceipt,
          submit: authorityReceipt(submitDraft, "performed")
        },
        filled: true,
        fields: resolved.length,
        submitted: true,
        ...(snapshot ? { ...snapshotToJson(snapshot), ...statusFields(snapshot) } : {}),
        ...(submitBudget
          ? {
              actionsUsed: submitBudget.label,
              ...(submitBudget.warning ? { budgetWarning: submitBudget.warning } : {})
            }
          : {})
      };
    }
  };
}

export type BrowserUploadPathValidationResult =
  | {
      readonly allowed: true;
      readonly cleanup: () => Promise<void>;
      readonly identity: BrowserUploadFileIdentity;
      readonly resolvedPath: string;
      readonly uploadPath: string;
    }
  | { readonly allowed: false; readonly reason: string };

export interface BrowserUploadFileIdentity {
  readonly bytes: number;
  readonly changedAtMs: number;
  readonly device: number;
  readonly inode: number;
  readonly modifiedAtMs: number;
  readonly sha256: string;
}

/**
 * Injected guard for the LOCAL file an upload would read. `browser_upload`
 * uploading a file means READING it from disk, so a prompt-injected page must
 * not be able to steer an upload at `~/.ssh/id_rsa`. The source path therefore
 * goes through the SAME allowlist/symlink guard `file_read` uses — wired at the
 * CLI boundary (dependency-injected, like the approval gate). `@muse/browser`
 * never reads an arbitrary local path itself: absent this validator the tool
 * fails closed (see `createBrowserUploadTool`).
 */
export type BrowserUploadPathValidator = (path: string) => Promise<BrowserUploadPathValidationResult>;

export interface BrowserUploadToolDeps {
  readonly controller: BrowserController;
  readonly approvalGate: BrowserApprovalGate;
  /**
   * Allowlist guard for the upload's SOURCE file (see BrowserUploadPathValidator).
   * Required in practice; if omitted, every upload is REFUSED (fail-closed — an
   * unguarded local read is never shipped).
   */
  readonly validatePath?: BrowserUploadPathValidator;
}

function sameUploadFileIdentity(
  left: BrowserUploadFileIdentity,
  right: BrowserUploadFileIdentity
): boolean {
  return left.bytes === right.bytes
    && left.changedAtMs === right.changedAtMs
    && left.device === right.device
    && left.inode === right.inode
    && left.modifiedAtMs === right.modifiedAtMs
    && left.sha256 === right.sha256;
}

function sameUploadTargetIdentity(
  left: NonNullable<BrowserActionDraft["uploadTarget"]>,
  right: NonNullable<BrowserActionDraft["uploadTarget"]>
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createBrowserUploadTool(deps: BrowserUploadToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Attach a local FILE from the user's computer to a file-upload control on the page open in Muse's " +
        "browser — e.g. attach a résumé to a job application, a photo to a form, a receipt to a claim. Say " +
        "WHICH upload control in `target` (its label or button text, e.g. 'Attach resume', 'Upload photo') " +
        "and the file in `path` (a path under the user's Downloads/Desktop/Documents, e.g. " +
        "'~/Downloads/resume.pdf'). Use ONLY to attach a file to a page's upload field — NOT to type text " +
        "(browser_type), NOT to click a button (browser_click), NOT to read a local file (file_read). The " +
        "canonical path, content hash/size, destination origin, and exact file-input identity are shown and " +
        "revalidated after confirmation before Muse attaches it (the file then leaves toward that site); " +
        "absent confirmation or any drift nothing is attached.",
      domain: "browser",
      groundedArgs: ["target", "path"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          path: { description: "The local file to attach — under Downloads/Desktop/Documents, e.g. '~/Downloads/resume.pdf'.", type: "string" },
          ref: { description: "Advanced: exact file-input ref from a prior snapshot. Prefer `target` instead.", type: "number" },
          target: { description: "Which upload control — its label or button text, e.g. 'Attach resume' or 'Upload photo'.", type: "string" }
        },
        required: ["target", "path"],
        type: "object"
      },
      keywords: ["browser", "upload", "업로드", "attach", "첨부", "file", "파일", "resume", "이력서", "photo", "사진", "브라우저"],
      name: "browser_upload",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const path = typeof args["path"] === "string" ? args["path"].trim() : "";
      if (path.length === 0) {
        return { reason: "browser_upload needs `path` — the local file to attach", uploaded: false };
      }
      // Resolve the target FIRST (so a bad target fails before anything reads
      // the file), but do NOT act until the path clears the allowlist guard.
      let resolved: ResolveResult;
      try {
        resolved = await resolveTarget(deps.controller, args, "click");
      } catch (cause) {
        return { uploaded: false, ...errorResult(cause) };
      }
      if ("error" in resolved) {
        return { uploaded: false, ...resolved.error };
      }
      if (!deps.controller.inspectUploadTarget) {
        return { reason: "browser controller cannot verify the upload field identity", uploaded: false };
      }
      let preliminaryTarget: BrowserUploadTargetIdentity;
      try {
        preliminaryTarget = await deps.controller.inspectUploadTarget(resolved.ref);
      } catch (cause) {
        return { uploaded: false, ...errorResult(cause) };
      }
      if (!preliminaryTarget.fileInput || preliminaryTarget.disabled) {
        return { reason: "the chosen upload target is not an enabled file input", uploaded: false };
      }
      // Allowlist + stable-content preparation for the SOURCE file. Production
      // returns a private staged copy whose bytes are the exact approved hash.
      if (!deps.validatePath) {
        return { reason: "no path validator wired — local file upload is fail-closed", uploaded: false };
      }
      let verdict: BrowserUploadPathValidationResult;
      try {
        verdict = await deps.validatePath(path);
      } catch (cause) {
        return { uploaded: false, reason: `path validation error: ${errorMessage(cause)}` };
      }
      if (!verdict.allowed) {
        return { reason: verdict.reason, uploaded: false };
      }
      let currentVerdict: Extract<BrowserUploadPathValidationResult, { readonly allowed: true }> | undefined;
      try {
        let draftResolved: ResolveResult;
        try {
          draftResolved = await resolveTarget(deps.controller, args, "click");
        } catch (cause) {
          return { uploaded: false, ...errorResult(cause) };
        }
        if (
          "error" in draftResolved
          || draftResolved.ref !== resolved.ref
          || draftResolved.label !== resolved.label
        ) {
          return { reason: "upload field changed while preparing the file; inspect again", uploaded: false };
        }
        let uploadTarget: BrowserUploadTargetIdentity;
        try {
          uploadTarget = await deps.controller.inspectUploadTarget(draftResolved.ref);
        } catch (cause) {
          return { uploaded: false, ...errorResult(cause) };
        }
        if (!uploadTarget.fileInput || uploadTarget.disabled) {
          return { reason: "the chosen upload target is not an enabled file input", uploaded: false };
        }
        const url = deps.controller.currentUrl();
        let origin: string;
        try {
          origin = new URL(url).origin;
        } catch {
          return { reason: "the current browser page has no valid destination origin", uploaded: false };
        }
        if (uploadTarget.pageUrl !== url) {
          return { reason: "page changed while inspecting the upload target", uploaded: false };
        }
        const file = Object.freeze({
          bytes: verdict.identity.bytes,
          sha256: verdict.identity.sha256
        });
        const frozenTarget = Object.freeze({ ...uploadTarget });
        const draft: BrowserActionDraft = Object.freeze({
          action: "upload",
          file,
          origin,
          path: verdict.resolvedPath,
          target: draftResolved.label,
          uploadTarget: frozenTarget,
          url
        });
        const decision = await resolveGateDecision(deps.approvalGate, draft);
        if (!decision.approved) {
          return { reason: decision.reason, uploaded: false };
        }
        let revalidated: BrowserUploadPathValidationResult;
        try {
          revalidated = await deps.validatePath(path);
        } catch (cause) {
          return {
            authorityReceipts: { upload: authorityReceipt(draft, "held") },
            reason: `path revalidation error: ${errorMessage(cause)}`,
            uploaded: false
          };
        }
        if (!revalidated.allowed) {
          return {
            authorityReceipts: { upload: authorityReceipt(draft, "held") },
            reason: revalidated.reason,
            uploaded: false
          };
        }
        currentVerdict = revalidated;
        if (
          currentVerdict.resolvedPath !== verdict.resolvedPath
          || !sameUploadFileIdentity(currentVerdict.identity, verdict.identity)
        ) {
          return {
            authorityReceipts: { upload: authorityReceipt(draft, "held") },
            reason: "upload file changed after approval; choose and approve the current file",
            uploaded: false
          };
        }
        if (deps.controller.currentUrl() !== draft.url) {
          return {
            authorityReceipts: { upload: authorityReceipt(draft, "held") },
            reason: "destination page changed during upload approval",
            uploaded: false
          };
        }
        let currentResolved: ResolveResult;
        try {
          currentResolved = await resolveTarget(deps.controller, args, "click");
        } catch (cause) {
          return {
            authorityReceipts: { upload: authorityReceipt(draft, "held") },
            uploaded: false,
            ...errorResult(cause)
          };
        }
        if (
          "error" in currentResolved
          || currentResolved.ref !== draftResolved.ref
          || currentResolved.label !== draftResolved.label
        ) {
          return {
            authorityReceipts: { upload: authorityReceipt(draft, "held") },
            reason: "upload field changed after approval; inspect again",
            uploaded: false
          };
        }
        let currentTarget: BrowserUploadTargetIdentity;
        try {
          currentTarget = await deps.controller.inspectUploadTarget(currentResolved.ref);
        } catch (cause) {
          return {
            authorityReceipts: { upload: authorityReceipt(draft, "held") },
            uploaded: false,
            ...errorResult(cause)
          };
        }
        if (
          !sameUploadTargetIdentity(frozenTarget, currentTarget)
          || currentTarget.pageUrl !== draft.url
          || !currentTarget.fileInput
          || currentTarget.disabled
        ) {
          return {
            authorityReceipts: { upload: authorityReceipt(draft, "held") },
            reason: "upload field identity changed after approval; inspect again",
            uploaded: false
          };
        }
        try {
          const uploadSource = currentVerdict;
          // Ownership of the private staged file transfers to the controller.
          // It must remain readable until the browser consumes/submits the
          // selected File, then is released on controller disconnect/close.
          currentVerdict = undefined;
          const snapshot = await deps.controller.uploadFile(
            currentResolved.ref,
            uploadSource.uploadPath,
            frozenTarget,
            uploadSource.cleanup
          );
          return {
            authorityReceipts: { upload: authorityReceipt(draft, "performed") },
            uploaded: true,
            ...snapshotToJson(snapshot),
            ...statusFields(snapshot)
          };
        } catch (cause) {
          return {
            authorityReceipts: { upload: authorityReceipt(draft, "failed") },
            uploaded: "unknown",
            ...errorResult(cause)
          };
        }
      } finally {
        await currentVerdict?.cleanup().catch(() => undefined);
        await verdict.cleanup().catch(() => undefined);
      }
    }
  };
}
