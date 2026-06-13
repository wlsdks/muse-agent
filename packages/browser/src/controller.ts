/**
 * `BrowserController` — the seam between Muse's browser tools and the
 * actual browser driver. Tools depend ONLY on this interface; the
 * default implementation (`PuppeteerBrowserController`) drives the
 * user's Chrome over CDP via puppeteer-core (Apache-2.0). Tests inject
 * a fake controller so the tool contracts are verified WITHOUT a real
 * browser.
 *
 * The model interacts with a page by REF: a `snapshot()` lists the
 * interactive elements each with a stable `ref`, and `click(ref)` /
 * `type(ref, …)` act on them. The controller remembers the last
 * snapshot's elements so a ref resolves to the right element.
 */

export interface SnapshotElement {
  /** Stable index for this snapshot — pass it to click()/type(). */
  readonly ref: number;
  /** Accessible role, e.g. 'link', 'button', 'textbox'. */
  readonly role: string;
  /** Accessible name / visible text / placeholder, capped. */
  readonly name: string;
  /**
   * For a link, its resolved absolute destination — so the model can REPORT
   * where a link goes (or hand the user a shareable URL) without navigating to
   * it. Absent for non-link controls (buttons, fields).
   */
  readonly url?: string;
}

export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  /** Trimmed visible text of the page, capped. */
  readonly text: string;
  /** Interactive elements the model can act on, capped. */
  readonly elements: readonly SnapshotElement[];
  /** A JS dialog (alert/confirm/prompt) that fired and was auto-accepted, if any. */
  readonly dialog?: { readonly type: string; readonly message: string };
  /**
   * HTTP status of the navigation that produced this snapshot (open / back).
   * `page.goto`/`goBack` RESOLVE on a 4xx/5xx, so a 404/500 error page loads
   * "successfully" and its content would otherwise read as the requested page.
   * Surfaced consume-once (like `dialog`) and only for navigations; a bare
   * re-read carries no status.
   */
  readonly httpStatus?: number;
}

export type ScrollDirection = "down" | "up" | "top" | "bottom";

export const BROWSER_KEYS = ["Escape", "Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
export type BrowserKey = (typeof BROWSER_KEYS)[number];

export interface BrowserController {
  /** Navigate to a URL and return the resulting page snapshot. */
  open(url: string): Promise<PageSnapshot>;
  /** Re-observe the current page. */
  snapshot(): Promise<PageSnapshot>;
  /** Click the element with this ref (from the last snapshot); returns the new snapshot. */
  click(ref: number): Promise<PageSnapshot>;
  /**
   * Move the mouse over the element and re-observe — reveals hover-triggered
   * menus / tooltips (CSS :hover, mouseover handlers) the snapshot can't see
   * until the pointer is over them.
   */
  hover(ref: number): Promise<PageSnapshot>;
  /** Type into the element with this ref; optionally press Enter to submit. */
  type(ref: number, text: string, submit: boolean): Promise<PageSnapshot>;
  /** Go back in history; returns the new snapshot. */
  back(): Promise<PageSnapshot>;
  /**
   * Press a keyboard key (Escape / Enter / Tab / arrows) and re-observe — closes
   * modals & dropdowns (Escape), moves focus (Tab), drives keyboard menus.
   */
  pressKey(key: BrowserKey): Promise<PageSnapshot>;
  /**
   * Scroll the page and re-observe — reveals below-the-fold and lazily-loaded
   * content the snapshot can't see until it renders.
   */
  scroll(direction: ScrollDirection): Promise<PageSnapshot>;
  /** Capture the page to a .png file. */
  screenshot(path: string): Promise<{ readonly path: string }>;
  /** Capture the current page as a base64 PNG (for the local vision model). */
  screenshotBase64(): Promise<string>;
  /** The element a ref points at in the last snapshot (for the approval draft). */
  describeElement(ref: number): SnapshotElement | undefined;
  /** The current page URL (for the approval draft). */
  currentUrl(): string;
  /**
   * Release the CDP connection but LEAVE the browser running — the open
   * socket otherwise pins the Node event loop and a one-shot CLI never
   * exits. The surviving browser is what the next invocation reconnects to.
   */
  disconnect(): Promise<void>;
  /** Close the browser (best-effort). */
  close(): Promise<void>;
}

export const BROWSER_MAX_TEXT = 4_000;
/** How many elements a single tool RESPONSE shows the model (paging unit). */
export const BROWSER_MAX_ELEMENTS = 50;
/**
 * Hard ceiling on elements the controller collects per snapshot. Grounding
 * (matchElement) runs over the WHOLE set in code, so it's generous; the model
 * only ever SEES `BROWSER_MAX_ELEMENTS` of them per response (the tool layer
 * pages + reports the total, so nothing is silently truncated).
 */
export const BROWSER_ELEMENT_CEILING = 200;
export const BROWSER_MAX_NAME = 120;
