/**
 * Read and navigation browser tools: open, read, back, look, scroll, wait,
 * key, hover. Imports its shared contract from browser-tool-primitives.js
 * (a leaf) — never from the browser-tools.js hub, which re-exports this.
 */

import { type JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { BROWSER_MAX_ELEMENTS, type BrowserController, type BrowserKey, BROWSER_KEYS } from "./controller.js";
import { filterElements } from "./matcher.js";
import { elementsJson, errorResult, normalizeBrowserUrl, resolveGateDecision, resolveTarget, snapshotToJson, statusFields, type BrowserActionDraft, type BrowserApprovalGate, type GateDecision, type ResolveResult } from "./browser-tool-primitives.js";

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
        "한국어 선택 규칙: 현재 페이지의 차트·그래프·도표가 무엇을 나타내는지 또는 무엇을 보여주는지 묻는 요청은 " +
        "'시각적으로'라는 표현이 없어도 browser_look을 호출하세요. 또한 '이 대시보드의 추세·패턴을 해석해줘'처럼 " +
        "현재 화면 데이터의 의미를 묻는 요청도 browser_look입니다. LOOK at the page open in Muse's browser " +
        "and describe what it shows visually — captures the page " +
        "and reads it with the local vision model. Use when the page is VISUAL and browser_read's text " +
        "misses it: a chart, graph, map, diagram, image, design, or an error/dialog the user is looking at " +
        "— e.g. 'what does this chart show?', '이 페이지 그래프 설명해줘', 'describe what's on the page'. " +
        "Pass `question` to focus the look. For the page's TEXT and clickable elements use browser_read instead; " +
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

export function createBrowserWaitTool(deps: BrowserReadToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Wait for the page in Muse's browser to FINISH loading content that arrives asynchronously, then " +
        "return the page. Pass `forText` (a word/phrase you expect to appear, e.g. 'Order confirmed', " +
        "'results') OR `selector` (a CSS selector, e.g. '.search-result'). Use when content loads AFTER an " +
        "action or a delay and isn't there yet — search results that stream in, a spinner that resolves, a " +
        "'Loading…' that becomes data — so a read doesn't grab the page too early. E.g. 'wait for the " +
        "results to load', '검색 결과가 로딩될 때까지 기다려줘', '페이지 다 뜰 때까지 기다려'. Do NOT use for content " +
        "that is ALREADY visible (use browser_read), and NOT to reveal below-the-fold content (use " +
        "browser_scroll). Reports `matched`: false means the awaited content never appeared — do not claim " +
        "it did. Read-only.",
      domain: "browser",
      inputSchema: {
        additionalProperties: false,
        properties: {
          forText: { description: "A substring you expect to appear once loaded, e.g. 'Order confirmed'.", type: "string" },
          selector: { description: "A CSS selector for an element you expect to appear, e.g. '.search-result' or '#results'.", type: "string" },
          timeoutMs: { description: "Optional max wait in ms (default 10000, capped at 30000), e.g. 8000.", maximum: 30_000, minimum: 500, type: "number" }
        },
        required: [],
        type: "object"
      },
      keywords: ["browser", "wait", "기다", "load", "로딩", "appear", "나타", "settle", "loaded", "ready", "브라우저"],
      name: "browser_wait",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const forText = typeof args["forText"] === "string" ? args["forText"].trim() : "";
      const selector = typeof args["selector"] === "string" ? args["selector"].trim() : "";
      if (forText.length === 0 && selector.length === 0) {
        return { error: "needs 'forText' (a phrase to wait for) or 'selector' (a CSS selector to wait for)" };
      }
      const timeoutMs = typeof args["timeoutMs"] === "number" && Number.isFinite(args["timeoutMs"]) ? args["timeoutMs"] : undefined;
      try {
        const outcome = await deps.controller.waitFor({
          ...(selector.length > 0 ? { selector } : { text: forText }),
          ...(timeoutMs !== undefined ? { timeoutMs } : {})
        });
        return {
          matched: outcome.matched,
          ...snapshotToJson(outcome.snapshot),
          ...(outcome.matched ? {} : { timedOut: true, note: `the awaited ${selector.length > 0 ? "element" : "text"} did not appear within the time limit — report only what is actually on the page` })
        };
      } catch (cause) {
        return errorResult(cause);
      }
    }
  };
}

export interface BrowserKeyToolDeps {
  readonly controller: BrowserController;
  /**
   * Draft-first gate for the ONE state-changing key, Enter (it confirms/submits
   * the focused control — a form post, a search submit). The navigation keys
   * (Escape/Tab/arrows) never call it. Absent ⇒ Enter fails closed (never pressed
   * ungated), so an Enter-submit can't slip past the approval the click/type
   * tools enforce (outbound-safety: a state-changing act is never autonomous).
   */
  readonly approvalGate?: BrowserApprovalGate;
}

export function createBrowserKeyTool(deps: BrowserKeyToolDeps): MuseTool {
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
      // Enter confirms/submits the focused control — a state-changing act that
      // must clear the same draft-first gate as a click. The navigation keys
      // (Escape/Tab/arrows) change nothing on the server and stay free.
      if (key === "Enter") {
        const draft: BrowserActionDraft = { action: "key", target: "Enter", url: deps.controller.currentUrl() };
        const decision: GateDecision = deps.approvalGate
          ? await resolveGateDecision(deps.approvalGate, draft)
          : { approved: false, reason: "no approval gate wired — Enter (a submit) is fail-closed" };
        if (!decision.approved) {
          return { pressed: false, reason: decision.reason };
        }
      }
      try {
        const snapshot = await deps.controller.pressKey(key as BrowserKey);
        return { ...snapshotToJson(snapshot), ...statusFields(snapshot) };
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

/**
 * Minimal structural seam for a per-task browser-action cap. `@muse/browser`
 * must not depend on `@muse/agent-core` — the CLI boundary wires in the real
 * tracker (`createBrowserActionTracker`); tests can fake this trivially.
 */
