/**
 * Muse's NATIVE browser-control tools (`@muse/browser`) — Hermes-style
 * `browser_*` tools that drive the user's Chrome over CDP via an injected
 * `BrowserController`. Snapshot-based: the model reads a page (title +
 * text + interactive elements with refs) and acts by ref.
 *
 * Safety split (outbound-safety.md): READING / navigating is free
 * (`browser_open`, `browser_read`, `browser_back`); page ACTS that can
 * change a third party's state (`browser_click`, `browser_type`) are
 * draft-first — the approval gate shows the exact action and fires only
 * on confirm (fail-closed: deny / undeliverable confirm ⇒ no act). The
 * gate + controller are INJECTED so the wiring lives at the CLI boundary.
 */

import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import type { BrowserController, PageSnapshot } from "./controller.js";
import { filterElements, matchElement, type MatchIntent } from "./matcher.js";

export interface BrowserActionDraft {
  readonly action: "click" | "type";
  readonly url: string;
  /** Human label of the target element ("Sign in" button). */
  readonly target: string;
  /** The text being typed (for `type` only). */
  readonly text?: string;
}

export interface BrowserApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
}

/** Presents the EXACT page action to the user; returns approve/deny. */
export type BrowserApprovalGate = (draft: BrowserActionDraft) => Promise<BrowserApprovalDecision> | BrowserApprovalDecision;

function snapshotToJson(snapshot: PageSnapshot): JsonObject {
  return {
    elements: snapshot.elements.map((element) => ({ name: element.name, ref: element.ref, role: element.role })) as unknown as JsonValue,
    text: snapshot.text,
    title: snapshot.title,
    url: snapshot.url
  };
}

function errorResult(cause: unknown): JsonObject {
  return { error: cause instanceof Error ? cause.message : String(cause) };
}

type ResolveResult = { readonly ref: number; readonly label: string } | { readonly error: JsonObject };

/**
 * Deterministic grounding: map the model's free-text `target` (or an explicit
 * `ref`) to a concrete element. A fresh snapshot is taken so the target resolves
 * against the live page — the small model never has to read the snapshot and
 * pick a ref itself.
 */
async function resolveTarget(controller: BrowserController, args: JsonObject, intent: MatchIntent): Promise<ResolveResult> {
  const target = typeof args["target"] === "string" ? args["target"].trim() : "";
  const refArg = typeof args["ref"] === "number" ? args["ref"] : Number.NaN;
  if (target.length > 0) {
    const snapshot = await controller.snapshot();
    const element = matchElement(snapshot.elements, target, intent);
    if (!element) {
      const available = snapshot.elements.slice(0, 12).map((entry) => `${entry.role}: ${entry.name}`);
      return { error: { available: available as unknown as JsonValue, reason: `couldn't find "${target}" on the page — re-read or pick from the listed elements` } };
    }
    return { label: `${element.role} "${element.name}"`, ref: element.ref };
  }
  if (Number.isInteger(refArg) && refArg >= 0) {
    const element = controller.describeElement(refArg);
    return { label: element ? `${element.role} "${element.name}"` : `element ref ${refArg.toString()}`, ref: refArg };
  }
  return { error: { reason: "needs a 'target' — what to act on, e.g. 'Sign in button' or 'search box'" } };
}

export interface BrowserReadToolDeps {
  readonly controller: BrowserController;
}

export function createBrowserOpenTool(deps: BrowserReadToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Open a web page in Muse's own browser and return what's on it — the title, the page text, and the " +
        "clickable elements (each with a `ref` you pass to browser_click / browser_type). Use when the user " +
        "wants to go to / open / visit a website or look something up on a specific page — e.g. 'open " +
        "example.com', 'go to the GitHub trending page and tell me the top repo', '이 사이트 열어서 내용 " +
        "정리해줘'. This browses + reads the page so you can then act on it; it is NOT for just launching a " +
        "URL for the user to look at, NOT web_action (a one-shot HTTP submit), and NOT for typing into or " +
        "clicking things on the page that is already open — browser_type / browser_click do that.",
      domain: "browser",
      groundedArgs: ["url"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          url: { description: "The URL to open, e.g. 'https://example.com'.", type: "string" }
        },
        required: ["url"],
        type: "object"
      },
      keywords: ["browser", "web", "page", "페이지", "site", "사이트", "open", "visit", "navigate", "url", "website", "브라우저"],
      name: "browser_open",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const url = typeof args["url"] === "string" ? args["url"].trim() : "";
      if (url.length === 0) {
        return { error: "browser_open requires a non-empty 'url'" };
      }
      try {
        return snapshotToJson(await deps.controller.open(url));
      } catch (cause) {
        return errorResult(cause);
      }
    }
  };
}

export function createBrowserReadTool(deps: BrowserReadToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Re-read the page currently open in Muse's browser — returns the title, page text, and the " +
        "interactive elements. Pass `find` to get only the elements matching a description (e.g. 'search', " +
        "'sign in') instead of the whole list — handy for locating one control. Use to see what's on the " +
        "page after it changed — e.g. 'what's on the page now?', 'read this page'. Read-only.",
      domain: "browser",
      inputSchema: {
        additionalProperties: false,
        properties: {
          find: { description: "Optional: only return elements whose label matches this, e.g. 'search box'.", type: "string" }
        },
        required: [],
        type: "object"
      },
      keywords: ["browser", "page", "페이지", "read", "읽어", "content", "내용", "find", "브라우저"],
      name: "browser_read",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      try {
        const snapshot = await deps.controller.snapshot();
        const find = typeof args["find"] === "string" ? args["find"].trim() : "";
        if (find.length === 0) {
          return snapshotToJson(snapshot);
        }
        const matched = filterElements(snapshot.elements, find);
        return {
          elements: matched.map((element) => ({ name: element.name, ref: element.ref, role: element.role })) as unknown as JsonValue,
          matched: matched.length,
          title: snapshot.title,
          url: snapshot.url
        };
      } catch (cause) {
        return errorResult(cause);
      }
    }
  };
}

export function createBrowserBackTool(deps: BrowserReadToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Go back to the previous page in Muse's browser and return the new page snapshot. Use when the user " +
        "asks to go back / return to the previous page — e.g. 'go back', '뒤로 가줘'.",
      domain: "browser",
      inputSchema: { additionalProperties: false, properties: {}, type: "object" },
      keywords: ["browser", "back", "뒤로", "previous", "이전", "return", "브라우저"],
      name: "browser_back",
      risk: "read"
    },
    execute: async (): Promise<JsonObject> => {
      try {
        return snapshotToJson(await deps.controller.back());
      } catch (cause) {
        return errorResult(cause);
      }
    }
  };
}

export interface BrowserActToolDeps {
  readonly controller: BrowserController;
  readonly approvalGate: BrowserApprovalGate;
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
      let decision: BrowserApprovalDecision;
      try {
        decision = await deps.approvalGate(draft);
      } catch (cause) {
        decision = { approved: false, reason: `approval gate error: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      if (!decision.approved) {
        return { clicked: false, reason: decision.reason ?? "not approved" };
      }
      try {
        return { clicked: true, ...snapshotToJson(await deps.controller.click(resolved.ref)) };
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
      let decision: BrowserApprovalDecision;
      try {
        decision = await deps.approvalGate(draft);
      } catch (cause) {
        decision = { approved: false, reason: `approval gate error: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      if (!decision.approved) {
        return { reason: decision.reason ?? "not approved", typed: false };
      }
      try {
        return { typed: true, ...snapshotToJson(await deps.controller.type(resolved.ref, text, submit)) };
      } catch (cause) {
        return { typed: false, ...errorResult(cause) };
      }
    }
  };
}
