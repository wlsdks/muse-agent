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
        "URL for the user to look at, and NOT web_action (a one-shot HTTP submit).",
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
      risk: "execute"
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
        "Re-read the page currently open in Muse's browser — returns the title, page text, and clickable " +
        "elements with their refs. Use to see what's on the page after it changed, or to find the element " +
        "you need before a browser_click / browser_type — e.g. 'what's on the page now?', 'read this page'. " +
        "Read-only.",
      domain: "browser",
      inputSchema: { additionalProperties: false, properties: {}, type: "object" },
      keywords: ["browser", "page", "페이지", "read", "읽어", "content", "내용", "브라우저"],
      name: "browser_read",
      risk: "read"
    },
    execute: async (): Promise<JsonObject> => {
      try {
        return snapshotToJson(await deps.controller.snapshot());
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
      risk: "execute"
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
        "Click an element on the page in Muse's browser, identified by its `ref` from browser_open / " +
        "browser_read. Use to follow a link or press a button — e.g. 'click the Sign in button', 'click the " +
        "first result'. The user MUST confirm before Muse clicks (a click can submit a form or change " +
        "something on a site); absent confirmation nothing happens. Returns the page after the click.",
      domain: "browser",
      inputSchema: {
        additionalProperties: false,
        properties: {
          ref: { description: "The element's ref number from the latest page snapshot, e.g. 3.", type: "number" }
        },
        required: ["ref"],
        type: "object"
      },
      keywords: ["browser", "click", "클릭", "press", "눌러", "button", "버튼", "link", "링크", "브라우저"],
      name: "browser_click",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const ref = typeof args["ref"] === "number" ? args["ref"] : Number.NaN;
      if (!Number.isInteger(ref) || ref < 0) {
        return { clicked: false, reason: "browser_click requires an integer 'ref' from the page snapshot" };
      }
      const element = deps.controller.describeElement(ref);
      const draft: BrowserActionDraft = {
        action: "click",
        target: element ? `${element.role} "${element.name}"` : `element ref ${ref.toString()}`,
        url: deps.controller.currentUrl()
      };
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
        return { clicked: true, ...snapshotToJson(await deps.controller.click(ref)) };
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
        "Type text into a field on the page in Muse's browser, identified by its `ref` from browser_open / " +
        "browser_read; set `submit` true to press Enter after. Use to fill a search box or a form field — " +
        "e.g. 'type \"laptop\" in the search box and submit', '검색창에 ... 입력해줘'. The user MUST confirm " +
        "before Muse types (it can submit a form / post to a site); absent confirmation nothing happens.",
      domain: "browser",
      groundedArgs: ["text"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          ref: { description: "The field's ref number from the latest page snapshot, e.g. 2.", type: "number" },
          submit: { description: "true to press Enter after typing (submit the form/search). Default false.", type: "boolean" },
          text: { description: "The text to type, e.g. 'wireless headphones'.", type: "string" }
        },
        required: ["ref", "text"],
        type: "object"
      },
      keywords: ["browser", "type", "입력", "fill", "검색창", "search box", "form", "폼", "enter", "브라우저"],
      name: "browser_type",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const ref = typeof args["ref"] === "number" ? args["ref"] : Number.NaN;
      const text = typeof args["text"] === "string" ? args["text"] : "";
      if (!Number.isInteger(ref) || ref < 0) {
        return { reason: "browser_type requires an integer 'ref' from the page snapshot", typed: false };
      }
      if (text.length === 0) {
        return { reason: "browser_type requires non-empty 'text'", typed: false };
      }
      const submit = args["submit"] === true;
      const element = deps.controller.describeElement(ref);
      const draft: BrowserActionDraft = {
        action: "type",
        target: element ? `${element.role} "${element.name}"` : `field ref ${ref.toString()}`,
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
        return { typed: true, ...snapshotToJson(await deps.controller.type(ref, text, submit)) };
      } catch (cause) {
        return { typed: false, ...errorResult(cause) };
      }
    }
  };
}
