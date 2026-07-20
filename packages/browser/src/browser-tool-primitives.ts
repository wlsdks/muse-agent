/**
 * Shared primitives for the browser tool family: the approval-draft contract
 * every gated tool speaks, snapshot-to-JSON projection, and URL
 * normalisation. A LEAF — the read and act tool modules both import from
 * here, so it must never import back from `browser-tools.js`.
 */

import { errorMessage, type JsonObject, type JsonValue } from "@muse/shared";

import { BROWSER_MAX_ELEMENTS, type BrowserController, type PageSnapshot } from "./controller.js";
import { matchElementResult, type MatchIntent } from "./matcher.js";
import { defangElementName, wrapPageContent } from "./page-content-guard.js";

export interface BrowserActionDraft {
  readonly action: "click" | "type" | "key" | "fill" | "upload";
  readonly url: string;
  /** Human label of the target element ("Sign in" button), or the key for `key`. */
  readonly target: string;
  /** The text being typed (for `type` only). */
  readonly text?: string;
  /** The local file path being attached (for `upload` only) — shown so the user confirms WHICH file leaves their machine. */
  readonly path?: string;
  /**
   * The resolved field→value pairs for a multi-field `fill` (browser_fill_form).
   * Each `target` is the RESOLVED element label (role + name), not the raw model
   * input, so the user confirms exactly what every field gets. Present only for
   * `action: "fill"` — the gate shows ALL of them in ONE confirm.
   */
  readonly fields?: ReadonlyArray<{ readonly target: string; readonly value: string }>;
}

export interface BrowserApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
}

/** Presents the EXACT page action to the user; returns approve/deny. */
export type BrowserApprovalGate = (draft: BrowserActionDraft) => Promise<BrowserApprovalDecision> | BrowserApprovalDecision;

export type GateDecision = { readonly approved: true } | { readonly approved: false; readonly reason: string };

/**
 * Shared click/type/fill/upload gate call: a denial's missing `reason` falls
 * back to "not approved", and a thrown gate turns into the same
 * "approval gate error: …" denial each call site used to build inline.
 */
export async function resolveGateDecision(gate: BrowserApprovalGate, draft: BrowserActionDraft): Promise<GateDecision> {
  try {
    const decision = await gate(draft);
    return decision.approved ? { approved: true } : { approved: false, reason: decision.reason ?? "not approved" };
  } catch (cause) {
    return { approved: false, reason: `approval gate error: ${errorMessage(cause)}` };
  }
}

export function elementsJson(elements: readonly PageSnapshot["elements"][number][]): JsonObject[] {
  return elements.map((element) => ({
    name: defangElementName(element.name),
    ref: element.ref,
    role: element.role,
    ...(element.url ? { url: element.url } : {})
  }));
}

/**
 * A page can carry hundreds of controls, but a low-spec model drowns in them —
 * so every response shows at most BROWSER_MAX_ELEMENTS and REPORTS the total +
 * the next offset rather than silently truncating (no silent caps). Grounding
 * (click/type by target) still matches the WHOLE set in code.
 */
export function snapshotToJson(snapshot: PageSnapshot, offset = 0): JsonObject {
  const total = snapshot.elements.length;
  const start = Math.min(Math.max(0, offset), total);
  const page = snapshot.elements.slice(start, start + BROWSER_MAX_ELEMENTS);
  const end = start + page.length;
  const linkCount = snapshot.elements.filter((element) => element.role === "link").length;
  return {
    elements: elementsJson(page),
    text: wrapPageContent(snapshot.text),
    title: snapshot.title,
    total,
    ...(linkCount > 0 ? { linkCount } : {}),
    url: snapshot.url,
    ...(start > 0 ? { offset: start } : {}),
    ...(end < total ? { hasMore: true, nextOffset: end } : {}),
    ...(snapshot.dialog ? { dialog: snapshot.dialog } : {})
  };
}

/**
 * A navigation's HTTP status, advisory-flagged ONLY when it is an error (>= 400).
 * `page.goto`/`goBack` resolve on a 4xx/5xx, so a 404/500 error page would
 * otherwise read to the model as the requested content — a silent grounding
 * hole. `statusError` is advisory (the user may legitimately want a 404 page's
 * content), not a hard refusal. Success (< 400), absent, or non-finite status
 * stays SILENT — no false alarm. Used by every navigating tool: browser_open /
 * browser_back AND the act tools (browser_click / browser_type / browser_key)
 * whose action can land on an error page.
 */
export function statusFields(snapshot: PageSnapshot): JsonObject {
  const status = snapshot.httpStatus;
  if (status === undefined || !Number.isFinite(status) || status < 400) return {};
  return {
    httpStatus: status,
    statusError: `the page returned HTTP ${status.toString()} — this is likely an error page, not the requested content; verify before relying on it`
  };
}

export function errorResult(cause: unknown): JsonObject {
  return { error: errorMessage(cause) };
}

/**
 * Accept only http(s) web pages for browser_open, and assume https for a bare
 * host. file:// / chrome:// / view-source: / javascript: / data: are refused —
 * otherwise browser_open would read ANY local file (a prompt-injected page
 * could steer it at ~/.ssh/id_rsa), bypassing file_read's allowlisted,
 * symlink-guarded local-read path. A `host:port` (digits after the colon) is a
 * bare host, not a scheme.
 */
export function normalizeBrowserUrl(raw: string): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { error: "browser_open requires a non-empty 'url'", ok: false };
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    const afterColon = trimmed.slice(schemeMatch[0].length);
    const looksLikeScheme = afterColon.startsWith("//") || !/^\d/.test(afterColon);
    if (looksLikeScheme && scheme !== "http" && scheme !== "https") {
      return { error: `browser_open only opens http(s) web pages — '${scheme}:' is refused. Use file_read for local files.`, ok: false };
    }
  }
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/u, "")}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: `browser_open only opens http(s) web pages — '${parsed.protocol}' is refused. Use file_read for local files.`, ok: false };
    }
    return { ok: true, url: parsed.href };
  } catch {
    return { error: `not a valid web URL: ${raw}`, ok: false };
  }
}

export type ResolveResult = { readonly ref: number; readonly label: string } | { readonly error: JsonObject };

/**
 * Deterministic grounding: map the model's free-text `target` (or an explicit
 * `ref`) to a concrete element. A fresh snapshot is taken so the target resolves
 * against the live page — the small model never has to read the snapshot and
 * pick a ref itself.
 */
export async function resolveTarget(controller: BrowserController, args: JsonObject, intent: MatchIntent): Promise<ResolveResult> {
  const target = typeof args["target"] === "string" ? args["target"].trim() : "";
  const refArg = typeof args["ref"] === "number" ? args["ref"] : Number.NaN;
  if (target.length > 0) {
    const snapshot = await controller.snapshot();
    const result = matchElementResult(snapshot.elements, target, intent);
    if (result.kind === "none") {
      const available = snapshot.elements.slice(0, 12).map((entry) => `${entry.role}: ${entry.name}`);
      return { error: { available, reason: `couldn't find "${target}" on the page — re-read or pick from the listed elements` } };
    }
    if (result.kind === "ambiguous") {
      // Fail-close: several equally-good matches and no ordinal to pick one. Do
      // NOT guess (a wrong click/type on someone else's page is irreversible).
      // Return the candidates so the model re-targets by ordinal.
      return {
        error: {
          ambiguous: result.candidates as unknown as JsonValue,
          reason: `"${target}" matches ${result.candidates.length.toString()} elements — which one? Re-target with an ordinal, e.g. "the first ${target}" or "the second ${target}".`
        }
      };
    }
    if (result.kind === "notypeable") {
      // The target named a button/link, not a text field — typing into it would
      // fail after the user already confirmed. Refuse and list the page's actual
      // typeable fields so the model retargets one (it never reaches the gate).
      const fieldNames = result.fields.map((field) => field.name).filter((name) => name.length > 0);
      const hint = fieldNames.length > 0 ? ` — type into one of these fields instead: ${fieldNames.join(", ")}` : " — there is no text field on this page";
      return {
        error: {
          fields: result.fields as unknown as JsonValue,
          reason: `"${target}" is not a text field${hint}.`
        }
      };
    }
    return { label: `${result.element.role} "${result.element.name}"`, ref: result.element.ref };
  }
  if (Number.isInteger(refArg) && refArg >= 0) {
    const element = controller.describeElement(refArg);
    if (!element) {
      return { error: { reason: `ref ${refArg.toString()} isn't on the current page — call browser_read to get fresh element refs, then act on one of those.` } };
    }
    return { label: `${element.role} "${element.name}"`, ref: refArg };
  }
  return { error: { reason: "needs a 'target' — what to act on, e.g. 'Sign in button' or 'search box'" } };
}
