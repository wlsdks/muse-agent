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
}

export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  /** Trimmed visible text of the page, capped. */
  readonly text: string;
  /** Interactive elements the model can act on, capped. */
  readonly elements: readonly SnapshotElement[];
}

export interface BrowserController {
  /** Navigate to a URL and return the resulting page snapshot. */
  open(url: string): Promise<PageSnapshot>;
  /** Re-observe the current page. */
  snapshot(): Promise<PageSnapshot>;
  /** Click the element with this ref (from the last snapshot); returns the new snapshot. */
  click(ref: number): Promise<PageSnapshot>;
  /** Type into the element with this ref; optionally press Enter to submit. */
  type(ref: number, text: string, submit: boolean): Promise<PageSnapshot>;
  /** Go back in history; returns the new snapshot. */
  back(): Promise<PageSnapshot>;
  /** Capture the page to a .png file. */
  screenshot(path: string): Promise<{ readonly path: string }>;
  /** The element a ref points at in the last snapshot (for the approval draft). */
  describeElement(ref: number): SnapshotElement | undefined;
  /** The current page URL (for the approval draft). */
  currentUrl(): string;
  /** Close the browser (best-effort). */
  close(): Promise<void>;
}

export const BROWSER_MAX_TEXT = 4_000;
export const BROWSER_MAX_ELEMENTS = 50;
export const BROWSER_MAX_NAME = 120;
