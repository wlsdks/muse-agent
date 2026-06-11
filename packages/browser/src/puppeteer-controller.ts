/**
 * Default `BrowserController` over the user's Chrome via puppeteer-core
 * (Apache-2.0, Google Chrome DevTools team). No bundled browser — it
 * launches the installed Chrome (channel 'chrome') with a DEDICATED Muse
 * profile so the user's main profile is never touched, visible
 * (headless:false) like Hermes. The browser is launched LAZILY on first
 * use, so importing/registering the tools costs nothing.
 *
 * Element refs: `snapshot()` tags each interactive element with a
 * `data-muse-ref` attribute and returns its {ref, role, name}; click()/
 * type() resolve the ref back to the live element via that attribute.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import {
  BROWSER_MAX_ELEMENTS,
  BROWSER_MAX_NAME,
  BROWSER_MAX_TEXT,
  type BrowserController,
  type PageSnapshot,
  type SnapshotElement
} from "./controller.js";

export interface PuppeteerBrowserControllerOptions {
  /** Explicit Chrome path; defaults to puppeteer-core's `channel: 'chrome'` lookup. */
  readonly executablePath?: string;
  /** Profile dir; defaults to ~/.muse/chrome-profile (kept off the user's main profile). */
  readonly userDataDir?: string;
  /** Navigation/settle timeout in ms. Default 15000. */
  readonly timeoutMs?: number;
  /** Run without a visible window (default false — Muse shows the browser). */
  readonly headless?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class PuppeteerBrowserController implements BrowserController {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private readonly options: PuppeteerBrowserControllerOptions;
  private lastElements = new Map<number, SnapshotElement>();
  private lastUrl = "";

  constructor(options: PuppeteerBrowserControllerOptions = {}) {
    this.options = options;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.browser || !this.browser.connected) {
      this.browser = await puppeteer.launch({
        defaultViewport: null,
        headless: this.options.headless ?? false,
        userDataDir: this.options.userDataDir ?? join(homedir(), ".muse", "chrome-profile"),
        args: ["--no-first-run", "--no-default-browser-check"],
        ...(this.options.executablePath ? { executablePath: this.options.executablePath } : { channel: "chrome" })
      });
    }
    const pages = await this.browser.pages();
    this.page = pages[0] ?? (await this.browser.newPage());
    return this.page;
  }

  private get timeout(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async open(url: string): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    await page.goto(url, { timeout: this.timeout, waitUntil: "domcontentloaded" });
    return this.snapshot();
  }

  async snapshot(): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    this.lastUrl = page.url();
    const title = await page.title();
    const text = (await page.evaluate(() => document.body?.innerText ?? "")).trim().slice(0, BROWSER_MAX_TEXT);
    const elements = (await page.evaluate((maxEls: number, maxName: number) => {
      const selector = "a[href], button, input, textarea, select, [role=button], [role=link], [role=textbox], [onclick]";
      const nodes = Array.from(document.querySelectorAll(selector));
      const out: Array<{ ref: number; role: string; name: string }> = [];
      let ref = 0;
      for (const el of nodes) {
        if (ref >= maxEls) break;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || (el as HTMLElement).offsetParent === null) continue;
        const tag = el.tagName.toLowerCase();
        const htmlEl = el as HTMLElement & { value?: string };
        const name = (
          el.getAttribute("aria-label") ||
          htmlEl.innerText ||
          htmlEl.value ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title") ||
          el.getAttribute("alt") ||
          ""
        ).trim().slice(0, maxName);
        const isField = tag === "input" || tag === "textarea" || tag === "select";
        if (!name && !isField) continue;
        const role =
          el.getAttribute("role") ||
          (tag === "a" ? "link" : tag === "button" ? "button" : isField ? "textbox" : "button");
        el.setAttribute("data-muse-ref", String(ref));
        out.push({ name, ref, role });
        ref += 1;
      }
      return out;
    }, BROWSER_MAX_ELEMENTS, BROWSER_MAX_NAME)) as SnapshotElement[];
    this.lastElements = new Map(elements.map((element) => [element.ref, element]));
    return { elements, text, title, url: this.lastUrl };
  }

  private async elementHandle(ref: number) {
    const page = await this.ensurePage();
    const handle = await page.$(`[data-muse-ref="${ref.toString()}"]`);
    if (!handle) {
      throw new Error(`no element with ref ${ref.toString()} on the current page — call browser_read again`);
    }
    return handle;
  }

  async click(ref: number): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    const handle = await this.elementHandle(ref);
    await handle.click();
    await page.waitForNetworkIdle({ idleTime: 500, timeout: this.timeout }).catch(() => { /* page may not navigate */ });
    return this.snapshot();
  }

  async type(ref: number, text: string, submit: boolean): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    const handle = await this.elementHandle(ref);
    await handle.click({ clickCount: 3 });
    await handle.type(text);
    if (submit) {
      await page.keyboard.press("Enter");
      await page.waitForNetworkIdle({ idleTime: 500, timeout: this.timeout }).catch(() => { /* may not navigate */ });
    }
    return this.snapshot();
  }

  async back(): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    await page.goBack({ timeout: this.timeout, waitUntil: "domcontentloaded" }).catch(() => { /* nothing to go back to */ });
    return this.snapshot();
  }

  async screenshot(path: string): Promise<{ readonly path: string }> {
    const page = await this.ensurePage();
    await page.screenshot({ path: path as `${string}.png` });
    return { path };
  }

  describeElement(ref: number): SnapshotElement | undefined {
    return this.lastElements.get(ref);
  }

  currentUrl(): string {
    return this.lastUrl;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => { /* best-effort */ });
    this.browser = undefined;
    this.page = undefined;
  }
}
