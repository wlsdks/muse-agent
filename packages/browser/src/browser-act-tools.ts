/**
 * Page-mutating browser tools: click, type, fill_form, upload. Every one is
 * approval-gated (draft-first per outbound-safety.md) and budget-capped via
 * BrowserActionGuard. Imports its shared contract from
 * browser-tool-primitives.js (a leaf), never from the browser-tools.js hub.
 */

import { errorMessage, type JsonObject, type JsonValue } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { type BrowserController, type PageSnapshot } from "./controller.js";
import { errorResult, resolveGateDecision, resolveTarget, snapshotToJson, statusFields, type BrowserActionDraft, type BrowserApprovalGate, type ResolveResult } from "./browser-tool-primitives.js";

export interface BrowserActionGuard {
  /** Consume one action from the per-task budget; refuses (allowed:false) once the cap is hit. */
  tryConsume(): { readonly allowed: boolean; readonly refusal?: string; readonly warning?: string; readonly label: string };
}

export interface BrowserActToolDeps {
  readonly controller: BrowserController;
  readonly approvalGate: BrowserApprovalGate;
  /** Optional per-task action budget shared across click/type/fill. Absent ⇒ unbounded (byte-identical to pre-budget behavior). */
  readonly actionBudget?: BrowserActionGuard;
}

export function createBrowserClickTool(deps: BrowserActToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Click something on the page in Muse's browser. Just say WHAT to click in `target` — the link text " +
        "or button label — and Muse finds it; e.g. target 'Sign in', 'Add to cart', 'the first result'. Use " +
        "to follow a link or press a button. The user MUST confirm before Muse clicks (a click can submit a " +
        "form or change something on a site); absent confirmation nothing happens. Returns the page after " +
        "the click.",
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

export function createBrowserTypeTool(deps: BrowserActToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Type text into a field on the page open in Muse's browser. '검색창에 X 입력하고 검색해줘' / 'type X " +
        "into the search box' means THIS tool — never browser_open (there is no URL to open; the field is on " +
        "the current page). Say WHICH field in `target` — its label or placeholder — and Muse finds it; set " +
        "`submit` true to press Enter after — e.g. target 'search', text 'wireless mouse', submit true. " +
        "Dropdowns too: put the option to choose in `text` (target 'Country', text 'Korea'). " +
        "The user MUST confirm before Muse types (it can submit a form / post to a site); absent " +
        "confirmation nothing happens.",
      domain: "browser",
      groundedArgs: ["target", "text"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          ref: { description: "Advanced: exact field ref from a prior snapshot. Prefer `target` instead.", type: "number" },
          submit: { description: "true to press Enter after typing (submit the form/search). Default false.", type: "boolean" },
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
      const draft: BrowserActionDraft = {
        action: "type",
        target: resolved.label,
        text: submit ? `${text} ⏎(submit)` : text,
        url: deps.controller.currentUrl()
      };
      const decision = await resolveGateDecision(deps.approvalGate, draft);
      if (!decision.approved) {
        return { reason: decision.reason, typed: false };
      }
      try {
        const snapshot = await deps.controller.type(resolved.ref, text, submit);
        return {
          typed: true,
          ...snapshotToJson(snapshot),
          ...statusFields(snapshot),
          ...(budget ? { actionsUsed: budget.label, ...(budget.warning ? { budgetWarning: budget.warning } : {}) } : {})
        };
      } catch (cause) {
        return { typed: false, ...errorResult(cause) };
      }
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
        "confirm ONCE — Muse shows every field→value pair and fills them all only on confirm; absent " +
        "confirmation nothing is typed.",
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
          submit: { description: "true to press Enter after the last field (submit the form). Default false.", type: "boolean" }
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
      const draftFields = resolved.map((entry) => ({ target: entry.label, value: entry.value }));
      const draft: BrowserActionDraft = {
        action: "fill",
        fields: submit ? draftFields.map((entry, i) => (i === draftFields.length - 1 ? { ...entry, value: `${entry.value} ⏎(submit)` } : entry)) : draftFields,
        target: `${resolved.length.toString()} fields`,
        url: deps.controller.currentUrl()
      };
      const decision = await resolveGateDecision(deps.approvalGate, draft);
      if (!decision.approved) {
        return { filled: false, reason: decision.reason };
      }
      let snapshot: PageSnapshot | undefined;
      try {
        for (let i = 0; i < resolved.length; i += 1) {
          const entry = resolved[i]!;
          // Only the LAST field carries `submit` — submitting mid-form would
          // post before the rest is typed (the same hazard the resolve-first
          // pass guards against, now at the fill stage).
          const isLast = i === resolved.length - 1;
          snapshot = await deps.controller.type(entry.ref, entry.value, submit && isLast);
        }
      } catch (cause) {
        return { filled: false, ...errorResult(cause) };
      }
      return {
        filled: true,
        fields: resolved.length,
        ...(snapshot ? { ...snapshotToJson(snapshot), ...statusFields(snapshot) } : {}),
        ...(budget ? { actionsUsed: budget.label, ...(budget.warning ? { budgetWarning: budget.warning } : {}) } : {})
      };
    }
  };
}

export type BrowserUploadPathValidationResult =
  | { readonly allowed: true; readonly resolvedPath: string }
  | { readonly allowed: false; readonly reason: string };

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
        "file path is checked against the allowed folders and the user MUST confirm before Muse attaches it " +
        "(the file then leaves toward that site); absent confirmation nothing is attached.",
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
      // Allowlist guard for the SOURCE file. Absent validator ⇒ fail-closed (an
      // unguarded local read is never shipped). A rejected path is refused
      // BEFORE the approval draft and BEFORE any read — the file never opens.
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
      const draft: BrowserActionDraft = { action: "upload", path, target: resolved.label, url: deps.controller.currentUrl() };
      const decision = await resolveGateDecision(deps.approvalGate, draft);
      if (!decision.approved) {
        return { reason: decision.reason, uploaded: false };
      }
      try {
        const snapshot = await deps.controller.uploadFile(resolved.ref, verdict.resolvedPath);
        return { uploaded: true, ...snapshotToJson(snapshot), ...statusFields(snapshot) };
      } catch (cause) {
        return { uploaded: false, ...errorResult(cause) };
      }
    }
  };
}
