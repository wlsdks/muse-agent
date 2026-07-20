/**
 * Re-export hub for the browser tool family. The tools split along the line
 * that actually matters — whether a tool can CHANGE the page:
 *
 *   browser-tool-primitives.ts — the approval-draft contract, snapshot
 *     projection, URL normalisation (a leaf; both sets import it)
 *   browser-read-tools.ts      — open, read, back, look, scroll, wait, key, hover
 *   browser-act-tools.ts       — click, type, fill_form, upload: every one
 *     approval-gated and budget-capped
 *
 * Hub stays re-export-only so neither sibling imports back through it.
 */

export {
  normalizeBrowserUrl,
  statusFields,
  type BrowserActionDraft,
  type BrowserApprovalDecision,
  type BrowserApprovalGate
} from "./browser-tool-primitives.js";

export {
  createBrowserBackTool,
  createBrowserHoverTool,
  createBrowserKeyTool,
  createBrowserLookTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserScrollTool,
  createBrowserWaitTool,
  type BrowserKeyToolDeps,
  type BrowserLookToolDeps,
  type BrowserReadToolDeps
} from "./browser-read-tools.js";

export {
  createBrowserClickTool,
  createBrowserFillFormTool,
  createBrowserTypeTool,
  createBrowserUploadTool,
  type BrowserActionGuard,
  type BrowserActToolDeps,
  type BrowserUploadPathValidationResult,
  type BrowserUploadPathValidator
} from "./browser-act-tools.js";
