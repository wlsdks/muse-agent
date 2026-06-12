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

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  Browser as InstalledBrowser,
  ChromeReleaseChannel,
  computeSystemExecutablePath
} from "@puppeteer/browsers";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";

import {
  BROWSER_ELEMENT_CEILING,
  BROWSER_MAX_NAME,
  BROWSER_MAX_TEXT,
  type BrowserController,
  type PageSnapshot,
  type ScrollDirection,
  type SnapshotElement
} from "./controller.js";
import { looksUnsettled, matchOption } from "./matcher.js";

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
// Bounded re-observe for SPA shells that render after domcontentloaded:
// an unsettled snapshot (no elements, stub text) waits and retries, max twice.
const SETTLE_RETRIES = 2;
const SETTLE_DELAY_MS = 700;

export class PuppeteerBrowserController implements BrowserController {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private readonly options: PuppeteerBrowserControllerOptions;
  private lastElements = new Map<number, SnapshotElement>();
  private lastUrl = "";

  constructor(options: PuppeteerBrowserControllerOptions = {}) {
    this.options = options;
  }

  private get userDataDir(): string {
    return this.options.userDataDir ?? join(homedir(), ".muse", "chrome-profile");
  }

  /**
   * The CLI exits after each answer but the (headful) Muse Chrome stays up —
   * so a later invocation must RECONNECT to it, not relaunch into a locked
   * profile. Chrome writes its CDP port to `DevToolsActivePort` inside the
   * profile dir; a stale file just fails the probe and we fall through to a
   * fresh launch. Loopback-only, Muse's dedicated profile.
   */
  private async connectToExisting(): Promise<Browser | undefined> {
    try {
      const portFile = await readFile(join(this.userDataDir, "DevToolsActivePort"), "utf8");
      const port = Number(portFile.split("\n")[0]);
      if (!Number.isInteger(port) || port <= 0) return undefined;
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port.toString()}`, defaultViewport: null });
    } catch {
      return undefined;
    }
  }

  /**
   * Chrome is spawned DETACHED and only ever driven over a CDP connect —
   * never as a puppeteer-owned child. A puppeteer.launch() child pins the
   * one-shot CLI's event loop (stdio handles + exit hooks), so `muse ask`
   * would answer and then hang forever; a detached browser outlives the
   * process and the next invocation reconnects to it.
   */
  private async launchDetached(): Promise<Browser> {
    const executable =
      this.options.executablePath ??
      process.env.MUSE_CHROME_PATH ??
      computeSystemExecutablePath({ browser: InstalledBrowser.CHROME, channel: ChromeReleaseChannel.STABLE });
    // A stale port file must not race the fresh launch's probe loop.
    await rm(join(this.userDataDir, "DevToolsActivePort"), { force: true }).catch(() => { /* best-effort */ });
    const child = spawn(executable, [
      `--user-data-dir=${this.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      ...(this.options.headless ?? false ? ["--headless"] : []),
      "about:blank"
    ], { detached: true, stdio: "ignore" });
    child.unref();
    // 150 × 200ms = 30s: a FRESH profile's first start can take >10s on a
    // loaded machine, and a too-short window misreads slow as missing.
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const browser = await this.connectToExisting();
      if (browser) return browser;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Chrome did not expose its DevTools port within 30s — is Chrome installed?");
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.browser || !this.browser.connected) {
      this.browser = (await this.connectToExisting()) ?? (await this.launchDetached());
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
    let snapshot = await this.captureSnapshot();
    for (let retry = 0; retry < SETTLE_RETRIES && looksUnsettled(snapshot); retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
      snapshot = await this.captureSnapshot();
    }
    return snapshot;
  }

  private async captureSnapshot(): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    this.lastUrl = page.url();
    const title = await page.title();
    const text = (await page.evaluate(() => document.body?.innerText ?? "")).trim().slice(0, BROWSER_MAX_TEXT);
    const elements = (await page.evaluate((maxEls: number, maxName: number) => {
      const selector =
        "a[href], button, input, textarea, select, [role=button], [role=link], [role=textbox], " +
        "[role=combobox], [role=searchbox], [role=checkbox], [role=radio], [role=menuitem], [role=tab], [onclick]";
      // Composed-tree walk — open shadow roots AND same-origin iframes are
      // pierced so web-component UIs and embedded forms/widgets (login,
      // checkout, comment boxes) aren't a blank page to the model. Cross-origin
      // frames throw on contentDocument access and are honestly skipped (CDP
      // can't reach them from this context).
      const nodes: Element[] = [];
      const walk = (root: ParentNode): void => {
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if (el.matches(selector)) nodes.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
          const tag = el.tagName.toLowerCase();
          if (tag === "iframe" || tag === "frame") {
            try {
              const doc = (el as HTMLIFrameElement).contentDocument;
              if (doc) walk(doc);
            } catch { /* cross-origin — out of scope */ }
          }
        }
      };
      walk(document);
      const out: Array<{ ref: number; role: string; name: string }> = [];
      // Dedup by role+name so a low-spec model sees a compact, distinct list
      // (nav bars repeat the same link many times — noise that wastes context).
      const seen = new Set<string>();
      let ref = 0;
      for (const el of nodes) {
        if (ref >= maxEls) break;
        const rect = el.getBoundingClientRect();
        // rect>0 alone filters display:none; an offsetParent check would also
        // drop position:fixed controls (cookie banners, sticky navs) and
        // shadow-root elements — both must stay visible.
        if (rect.width <= 0 || rect.height <= 0) continue;
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
        ).trim().replace(/\s+/g, " ").slice(0, maxName);
        const isField = tag === "input" || tag === "textarea" || tag === "select";
        if (!name && !isField) continue;
        const role =
          el.getAttribute("role") ||
          (tag === "a" ? "link" : tag === "button" ? "button" : tag === "select" ? "combobox" : isField ? "textbox" : "button");
        const key = `${role}\u0000${name}`;
        if (name && seen.has(key)) continue;
        if (name) seen.add(key);
        el.setAttribute("data-muse-ref", String(ref));
        out.push({ name, ref, role });
        ref += 1;
      }
      return out;
    }, BROWSER_ELEMENT_CEILING, BROWSER_MAX_NAME)) as SnapshotElement[];
    this.lastElements = new Map(elements.map((element) => [element.ref, element]));
    return { elements, text, title, url: this.lastUrl };
  }

  /**
   * Resolve a ref to its element AND the frame it lives in. A ref can sit in
   * the main document, an open shadow root (pierce/), or a same-origin iframe —
   * so we search every frame, not just the main one, or an iframe-embedded
   * control would be visible in the snapshot yet un-clickable.
   */
  private async resolveRef(ref: number): Promise<{ frame: Frame; selector: string }> {
    const page = await this.ensurePage();
    const selector = `pierce/[data-muse-ref="${ref.toString()}"]`;
    for (const frame of page.frames()) {
      const handle = await frame.$(selector).catch(() => null);
      if (handle) {
        await handle.dispose();
        return { frame, selector };
      }
    }
    throw new Error(`no element with ref ${ref.toString()} on the current page — call browser_read again`);
  }

  async click(ref: number): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    const { frame, selector } = await this.resolveRef(ref);
    // Locator (not a raw handle): auto-waits for visible/enabled/stable before
    // acting — the reliable-interaction pattern from the Puppeteer guide. Scoped
    // to the resolved frame so iframe-embedded controls work.
    await frame.locator(selector).setTimeout(this.timeout).click();
    await page.waitForNetworkIdle({ idleTime: 500, timeout: this.timeout }).catch(() => { /* page may not navigate */ });
    return this.snapshot();
  }

  async type(ref: number, text: string, submit: boolean): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    const { frame, selector } = await this.resolveRef(ref);
    const handle = await frame.$(selector);
    if (!handle) {
      throw new Error(`no element with ref ${ref.toString()} on the current page — call browser_read again`);
    }
    const tag = await handle.evaluate((el) => el.tagName.toLowerCase());
    if (tag === "select") {
      // Dropdowns can't be typed into — ground the text to an option in
      // code; an unmatchable option is refused, never guessed (fail-close).
      const options = await handle.evaluate((el) =>
        Array.from((el as HTMLSelectElement).options).map((option) => ({
          label: (option.label || option.textContent || "").trim(),
          value: option.value
        }))
      );
      const matched = matchOption(options, text);
      if (!matched) {
        const labels = options.map((option) => option.label).filter((label) => label.length > 0).join(", ");
        throw new Error(`no option matching "${text}" in this dropdown — options: ${labels}`);
      }
      await handle.select(matched.value);
      return this.snapshot();
    }
    try {
      await frame.locator(selector).setTimeout(this.timeout).fill(text);
    } catch {
      // Custom widgets that reject fill() still accept raw keystrokes.
      await handle.click({ count: 3 });
      await handle.type(text);
    }
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

  async scroll(direction: ScrollDirection): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    await page.evaluate((dir: string) => {
      const by = Math.round(window.innerHeight * 0.9);
      if (dir === "top") window.scrollTo({ top: 0 });
      else if (dir === "bottom") window.scrollTo({ top: document.body.scrollHeight });
      else window.scrollBy({ top: dir === "up" ? -by : by });
    }, direction);
    // Lazy-loaders fire on scroll — let the new content settle before observing.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: this.timeout }).catch(() => { /* static page */ });
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

  async disconnect(): Promise<void> {
    try {
      await this.browser?.disconnect();
    } catch { /* best-effort */ }
    this.browser = undefined;
    this.page = undefined;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => { /* best-effort */ });
    this.browser = undefined;
    this.page = undefined;
  }
}
