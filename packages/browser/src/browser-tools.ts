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

import { BROWSER_KEYS, BROWSER_MAX_ELEMENTS, type BrowserController, type BrowserKey, type PageSnapshot } from "./controller.js";
import { filterElements, matchElementResult, type MatchIntent } from "./matcher.js";

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

function elementsJson(elements: readonly PageSnapshot["elements"][number][]): JsonValue {
  return elements.map((element) => ({
    name: element.name,
    ref: element.ref,
    role: element.role,
    ...(element.url ? { url: element.url } : {})
  })) as unknown as JsonValue;
}

/**
 * A page can carry hundreds of controls, but a low-spec model drowns in them —
 * so every response shows at most BROWSER_MAX_ELEMENTS and REPORTS the total +
 * the next offset rather than silently truncating (no silent caps). Grounding
 * (click/type by target) still matches the WHOLE set in code.
 */
function snapshotToJson(snapshot: PageSnapshot, offset = 0): JsonObject {
  const total = snapshot.elements.length;
  const start = Math.min(Math.max(0, offset), total);
  const page = snapshot.elements.slice(start, start + BROWSER_MAX_ELEMENTS);
  const end = start + page.length;
  return {
    elements: elementsJson(page),
    text: snapshot.text,
    title: snapshot.title,
    total,
    url: snapshot.url,
    ...(start > 0 ? { offset: start } : {}),
    ...(end < total ? { hasMore: true, nextOffset: end } : {}),
    ...(snapshot.dialog ? { dialog: snapshot.dialog as unknown as JsonValue } : {})
  };
}

/**
 * A navigation's HTTP status, advisory-flagged ONLY when it is an error (>= 400).
 * `page.goto`/`goBack` resolve on a 4xx/5xx, so a 404/500 error page would
 * otherwise read to the model as the requested content — a silent grounding
 * hole. `statusError` is advisory (the user may legitimately want a 404 page's
 * content), not a hard refusal. Success (< 400), absent, or non-finite status
 * stays SILENT — no false alarm. Used by browser_open / browser_back only.
 */
export function statusFields(snapshot: PageSnapshot): JsonObject {
  const status = snapshot.httpStatus;
  if (status === undefined || !Number.isFinite(status) || status < 400) return {};
  return {
    httpStatus: status,
    statusError: `the page returned HTTP ${status.toString()} — this is likely an error page, not the requested content; verify before relying on it`
  };
}

function errorResult(cause: unknown): JsonObject {
  return { error: cause instanceof Error ? cause.message : String(cause) };
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
    const result = matchElementResult(snapshot.elements, target, intent);
    if (result.kind === "none") {
      const available = snapshot.elements.slice(0, 12).map((entry) => `${entry.role}: ${entry.name}`);
      return { error: { available: available as unknown as JsonValue, reason: `couldn't find "${target}" on the page — re-read or pick from the listed elements` } };
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
      const raw = typeof args["url"] === "string" ? args["url"] : "";
      const normalized = normalizeBrowserUrl(raw);
      if (!normalized.ok) {
        return { error: normalized.error };
      }
      try {
        const snapshot = await deps.controller.open(normalized.url);
        return { ...snapshotToJson(snapshot), ...statusFields(snapshot) };
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
        "interactive elements (each link also carries its destination `url`, so you can tell the user WHERE " +
        "a link goes or hand them a shareable link without clicking it). Pass `find` to get only the " +
        "elements matching a description (e.g. 'search', 'sign in') instead of the whole list. A long page " +
        "reports `total` + `hasMore`/`nextOffset`; pass `offset` to read the next batch. Use to see the TEXT " +
        "and clickable elements after the page changed, or to get a link's URL — e.g. 'what's on the page " +
        "now?', 'read this page', 'what's the link to their pricing page?'. NOT for describing VISUAL content like a chart, " +
        "graph, image, or diagram (use browser_look — this returns DOM text, not a picture). Read-only.",
      domain: "browser",
      inputSchema: {
        additionalProperties: false,
        properties: {
          find: { description: "Optional: only return elements whose label matches this, e.g. 'search box'.", type: "string" },
          offset: { description: "Optional: skip this many elements (paging a long page); use the `nextOffset` from a prior read.", type: "number" }
        },
        required: [],
        type: "object"
      },
      keywords: ["browser", "page", "페이지", "read", "읽어", "content", "내용", "find", "more", "브라우저"],
      name: "browser_read",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      try {
        const snapshot = await deps.controller.snapshot();
        const find = typeof args["find"] === "string" ? args["find"].trim() : "";
        if (find.length === 0) {
          const offset = typeof args["offset"] === "number" && Number.isFinite(args["offset"]) ? Math.trunc(args["offset"]) : 0;
          return snapshotToJson(snapshot, offset);
        }
        const matched = filterElements(snapshot.elements, find);
        // Page the FILTERED list the same way snapshotToJson pages the full one:
        // honour `offset` and emit `nextOffset`. The description promises
        // `hasMore`/`nextOffset` paging; without this the find branch reported
        // hasMore but ignored offset, so a >50-match list looped on the first 50.
        const offset = typeof args["offset"] === "number" && Number.isFinite(args["offset"]) ? Math.trunc(args["offset"]) : 0;
        const start = Math.min(Math.max(0, offset), matched.length);
        const shown = matched.slice(start, start + BROWSER_MAX_ELEMENTS);
        const end = start + shown.length;
        return {
          elements: elementsJson(shown),
          matched: matched.length,
          title: snapshot.title,
          url: snapshot.url,
          ...(start > 0 ? { offset: start } : {}),
          ...(end < matched.length ? { hasMore: true, nextOffset: end } : {})
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
        const snapshot = await deps.controller.back();
        return { ...snapshotToJson(snapshot), ...statusFields(snapshot) };
      } catch (cause) {
        return errorResult(cause);
      }
    }
  };
}

export interface BrowserLookToolDeps {
  readonly controller: BrowserController;
  /** Local vision callback (the CLI binds it to the assembly's multimodal model). */
  readonly describeImage: (input: { readonly imageBase64: string; readonly mimeType: string; readonly question?: string }) => Promise<{ readonly ok: boolean; readonly text?: string; readonly error?: string }>;
}

export function createBrowserLookTool(deps: BrowserLookToolDeps): MuseTool {
  return {
    definition: {
      description:
        "LOOK at the page open in Muse's browser and describe what it shows visually — captures the page " +
        "and reads it with the local vision model. Use when the page is VISUAL and browser_read's text " +
        "misses it: a chart, graph, map, diagram, image, design, or an error/dialog the user is looking at " +
        "— e.g. 'what does this chart show?', '이 페이지 그래프 설명해줘', 'describe what's on the page'. Pass " +
        "`question` to focus the look. For the page's TEXT and clickable elements use browser_read instead; " +
        "this is for the pixels.",
      domain: "browser",
      inputSchema: {
        additionalProperties: false,
        properties: {
          question: { description: "Optional focus, e.g. 'what's the trend in the chart?'.", type: "string" }
        },
        required: [],
        type: "object"
      },
      keywords: ["browser", "look", "see", "chart", "그래프", "차트", "graph", "diagram", "그림", "보여", "시각", "visual", "브라우저"],
      name: "browser_look",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      let imageBase64: string;
      try {
        imageBase64 = await deps.controller.screenshotBase64();
      } catch (cause) {
        return { described: false, ...errorResult(cause) };
      }
      const question = typeof args["question"] === "string" && args["question"].trim().length > 0 ? args["question"].trim() : undefined;
      const described = await deps.describeImage({ imageBase64, mimeType: "image/png", ...(question ? { question } : {}) });
      if (!described.ok || !described.text) {
        return { described: false, reason: described.error ?? "the vision model could not read the page" };
      }
      return { described: true, text: described.text };
    }
  };
}

const SCROLL_DIRECTIONS = ["down", "up", "top", "bottom"] as const;

export function createBrowserScrollTool(deps: BrowserReadToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Scroll the page in Muse's browser to reveal content that isn't visible yet — below-the-fold or " +
        "lazily-loaded items (infinite-scroll feeds, long product lists). `direction` is 'down' / 'up' / " +
        "'top' / 'bottom'. Use when the page text or elements seem cut off, or the user asks to scroll / see " +
        "more / go to the bottom — e.g. 'scroll down', '더 아래로', '맨 아래로 가줘'. Returns the page after " +
        "scrolling (new content included). Read-only.",
      domain: "browser",
      inputSchema: {
        additionalProperties: false,
        properties: {
          direction: { description: "Where to scroll: 'down', 'up', 'top', or 'bottom'.", enum: [...SCROLL_DIRECTIONS], type: "string" }
        },
        required: ["direction"],
        type: "object"
      },
      keywords: ["browser", "scroll", "스크롤", "down", "아래", "up", "위", "bottom", "맨아래", "more", "더보기", "브라우저"],
      name: "browser_scroll",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const direction = typeof args["direction"] === "string" ? args["direction"].trim() : "";
      if (!SCROLL_DIRECTIONS.includes(direction as (typeof SCROLL_DIRECTIONS)[number])) {
        return { error: `direction must be one of: ${SCROLL_DIRECTIONS.join(", ")}` };
      }
      try {
        return snapshotToJson(await deps.controller.scroll(direction as (typeof SCROLL_DIRECTIONS)[number]));
      } catch (cause) {
        return errorResult(cause);
      }
    }
  };
}

export function createBrowserKeyTool(deps: BrowserReadToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Press a keyboard key in Muse's browser: 'Escape' (close a modal / dropdown / popup), 'Enter' " +
        "(confirm the focused control), 'Tab' (move focus to the next field), or an arrow key " +
        "('ArrowDown' / 'ArrowUp' / 'ArrowLeft' / 'ArrowRight', e.g. to move through a dropdown). Use when a " +
        "dialog or menu won't go away, or to navigate by keyboard — e.g. 'close this popup', 'press escape', " +
        "'esc 눌러줘'. Returns the page after the keypress.",
      domain: "browser",
      inputSchema: {
        additionalProperties: false,
        properties: {
          key: { description: "Which key to press, e.g. 'Escape' or 'ArrowDown'.", enum: [...BROWSER_KEYS], type: "string" }
        },
        required: ["key"],
        type: "object"
      },
      keywords: ["browser", "key", "키", "escape", "esc", "닫", "close", "enter", "tab", "arrow", "화살표", "키보드", "브라우저"],
      name: "browser_key",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const key = typeof args["key"] === "string" ? args["key"].trim() : "";
      if (!BROWSER_KEYS.includes(key as BrowserKey)) {
        return { error: `key must be one of: ${BROWSER_KEYS.join(", ")}` };
      }
      try {
        return snapshotToJson(await deps.controller.pressKey(key as BrowserKey));
      } catch (cause) {
        return errorResult(cause);
      }
    }
  };
}

export function createBrowserHoverTool(deps: BrowserReadToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Move the mouse over an element in Muse's browser to REVEAL a menu or tooltip that only appears on " +
        "hover — say WHAT to hover in `target` (the menu label or link text). Use when a dropdown nav or " +
        "submenu won't show until hovered — e.g. 'hover over Account to see the menu', '계정 메뉴 위에 " +
        "올려줘'. Returns the page with the now-revealed items (then browser_click one). Read-only — it " +
        "changes nothing, just reveals.",
      domain: "browser",
      groundedArgs: ["target"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          target: { description: "What to hover over — the menu label or link text, e.g. 'Account' or 'Products'.", type: "string" }
        },
        required: ["target"],
        type: "object"
      },
      keywords: ["browser", "hover", "호버", "메뉴", "menu", "submenu", "tooltip", "올려", "mouseover", "브라우저"],
      name: "browser_hover",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      let resolved: ResolveResult;
      try {
        resolved = await resolveTarget(deps.controller, args, "click");
      } catch (cause) {
        return errorResult(cause);
      }
      if ("error" in resolved) {
        return resolved.error;
      }
      try {
        return snapshotToJson(await deps.controller.hover(resolved.ref));
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
