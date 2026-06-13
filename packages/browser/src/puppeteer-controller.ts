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
import puppeteer, { type Browser, type ElementHandle, type Frame, type HTTPResponse, type Page } from "puppeteer-core";

import {
  BROWSER_ELEMENT_CEILING,
  BROWSER_MAX_NAME,
  BROWSER_MAX_TEXT,
  type BrowserController,
  type BrowserKey,
  type PageSnapshot,
  type ScrollDirection,
  type SnapshotElement,
  type WaitCondition,
  type WaitOutcome
} from "./controller.js";
import { looksUnsettled, matchOption } from "./matcher.js";

export interface PuppeteerBrowserControllerOptions {
  /** Explicit Chrome path; defaults to puppeteer-core's `channel: 'chrome'` lookup. */
  readonly executablePath?: string;
  /** Profile dir; defaults to ~/.muse/chrome-profile (kept off the user's main profile). */
  readonly userDataDir?: string;
  /** Navigation/settle timeout in ms. Default 15000. */
  readonly timeoutMs?: number;
  /**
   * Hard ceiling on any single CDP roundtrip (ms). Puppeteer's own default is
   * 180000 (3 min) — far longer than `timeoutMs`, and it bounds the calls that
   * carry NO higher-level timeout (the snapshot `page.evaluate`s: innerText, the
   * element walk). So a stuck/pathological page wedges the agent for 3 min with
   * no recovery. Default here is `timeoutMs` + headroom, capped well under 180s.
   */
  readonly protocolTimeoutMs?: number;
  /** Run without a visible window (default false — Muse shows the browser). */
  readonly headless?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
// Headroom over the per-operation timeout: a legitimate slow nav/settle runs to
// `timeout`, and the protocol layer must NOT kill it first — so the CDP ceiling
// sits a margin above. Still ~5× under puppeteer's silent 180s default, so a
// genuinely stuck roundtrip fails fast and recoverably instead of hanging.
const PROTOCOL_TIMEOUT_HEADROOM_MS = 15_000;
// How long to wait for a click/submit to spawn a new tab before assuming none —
// `targetcreated` fires at click time, so this only taxes a no-new-tab action.
const NEW_TAB_WINDOW_MS = 500;
// Bounded re-observe for SPA shells that render after domcontentloaded:
// an unsettled snapshot (no elements, stub text) waits and retries, max twice.
const SETTLE_RETRIES = 2;
const SETTLE_DELAY_MS = 700;
// browser_wait bounds: a sensible default for async content (most fetch-render
// resolves well under this) and a hard ceiling so a never-arriving condition
// can't wedge the agent. The effective wait is also clamped below the CDP
// protocol ceiling so the waitForFunction roundtrip never out-races its own
// timeout (which would surface as a protocol error, not an honest no-match).
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 30_000;
const WAIT_MIN_MS = 500;

export class PuppeteerBrowserController implements BrowserController {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private readonly options: PuppeteerBrowserControllerOptions;
  private lastElements = new Map<number, SnapshotElement>();
  private lastUrl = "";
  private lastDialog: { readonly type: string; readonly message: string; readonly response?: string } | undefined;
  private lastHttpStatus: number | undefined;

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
      return await puppeteer.connect({
        browserURL: `http://127.0.0.1:${port.toString()}`,
        defaultViewport: null,
        protocolTimeout: this.protocolTimeout
      });
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
    this.registerDialogHandler(this.page);
    return this.page;
  }

  /**
   * A JS dialog (alert/confirm/prompt/beforeunload) BLOCKS the page until it's
   * answered — with no handler, the next click/goto hangs to the timeout. The act
   * that triggers it was already draft-first approved by the human upstream
   * (outbound-safety), so we ACCEPT to complete that intent, and RECORD the dialog
   * so the result stays transparent. Registered once per page.
   *
   * A `prompt` is accepted with the dialog's OWN `defaultValue` — not the bare
   * `accept()` empty string — because `dialog.accept()` with no argument submits
   * "", discarding the page's intended pre-fill. So "Enter coupon code"
   * (default "SAVE10") would receive blank and the page proceeds with garbage.
   * We never invent text; we submit what the PAGE proposed, and record it in
   * `response` so the model can see (and flag) what was sent.
   */
  private registerDialogHandler(page: Page): void {
    if (page.listenerCount("dialog") > 0) return;
    page.on("dialog", (dialog) => {
      const isPrompt = dialog.type() === "prompt";
      const response = isPrompt ? dialog.defaultValue() : undefined;
      this.lastDialog = {
        message: dialog.message(),
        type: dialog.type(),
        ...(isPrompt ? { response } : {})
      };
      dialog.accept(isPrompt ? response : undefined).catch(() => { /* already handled / page gone */ });
    });
  }

  /**
   * Run an action that MIGHT open a new tab (`target=_blank`, `window.open`) and
   * follow it if it does — the model must observe the new tab, not the stale
   * original. The `targetcreated` listener is armed BEFORE the action (a new tab
   * registers asynchronously, so checking `pages()` after the click races and
   * misses it); if nothing opens within a short window we keep the current page.
   */
  private async withNewTabFollow(action: () => Promise<void>): Promise<void> {
    const browser = this.browser;
    if (!browser) { await action(); return; }
    let resolveNew: (page: Page | null) => void = () => { /* set below */ };
    const opened = new Promise<Page | null>((resolve) => { resolveNew = resolve; });
    const onTarget = (target: { page: () => Promise<Page | null> }): void => {
      target.page().then((page) => resolveNew(page)).catch(() => resolveNew(null));
    };
    browser.once("targetcreated", onTarget);
    try {
      await action();
      // A new tab fires `targetcreated` essentially at click time, so a short
      // window catches it; a normal click (no new tab) isn't taxed beyond it.
      const newest = await Promise.race([
        opened,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), NEW_TAB_WINDOW_MS))
      ]);
      if (newest && !newest.isClosed()) {
        this.page = newest;
        this.registerDialogHandler(newest);
        await newest.bringToFront().catch(() => { /* best-effort */ });
        await newest.waitForNetworkIdle({ idleTime: 500, timeout: this.timeout }).catch(() => { /* static popup */ });
      }
    } finally {
      browser.off("targetcreated", onTarget);
    }
  }

  /**
   * Run an action that MIGHT navigate the main frame and capture the resulting
   * document's HTTP status, exactly like `open`/`back` already do — so a click /
   * type-submit / Enter that lands on a 404/500 error page surfaces `httpStatus`
   * and isn't read as the requested content (the same grounding hole `open`
   * closed, but for the ACT path, which never went through goto/goBack). The
   * `response` event is per-PAGE, so we arm it on the current page AND on any new
   * tab the action opens (a click can follow a `target=_blank`, whose document
   * status is the one the model will read). Only the LAST top-level document
   * response is recorded — subresources (scripts/XHR/sub-frames) carry their own
   * statuses that must NOT read as the page's. A click that changes nothing
   * in-page emits no document response, leaving the status untouched (the
   * `snapshot()` consume-once machinery clears any stale value either way).
   */
  private async withNavStatus(action: () => Promise<void>): Promise<void> {
    const browser = this.browser;
    let navStatus: number | undefined;
    const armed: Page[] = [];
    const onResponse = (response: HTTPResponse): void => {
      try {
        const request = response.request();
        if (request.resourceType() !== "document") return;
        if (request.frame() !== response.frame()?.page()?.mainFrame()) return;
        navStatus = response.status();
      } catch { /* response/frame torn down mid-flight */ }
    };
    const arm = (page: Page | undefined): void => {
      if (page && !page.isClosed() && !armed.includes(page)) {
        page.on("response", onResponse);
        armed.push(page);
      }
    };
    arm(this.page);
    const onTarget = (target: { page: () => Promise<Page | null> }): void => {
      target.page().then((page) => arm(page ?? undefined)).catch(() => { /* target gone */ });
    };
    browser?.on("targetcreated", onTarget);
    try {
      await action();
    } finally {
      browser?.off("targetcreated", onTarget);
      for (const page of armed) page.off("response", onResponse);
    }
    if (navStatus !== undefined) this.lastHttpStatus = navStatus;
  }

  private get timeout(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * The CDP-roundtrip ceiling. Always kept ABOVE `timeout` so the protocol
   * layer never kills a legitimately slow op the operation timeout would own;
   * an explicit too-small value is clamped up to `timeout` + headroom.
   */
  private get protocolTimeout(): number {
    const floor = this.timeout + PROTOCOL_TIMEOUT_HEADROOM_MS;
    const requested = this.options.protocolTimeoutMs;
    return requested === undefined ? floor : Math.max(requested, floor);
  }

  /**
   * Wait for the DOM to stop mutating after an action — catches content inserted
   * by setTimeout / fetch-then-render that `networkidle` alone misses (a click
   * that AJAXes in the next step, no network = idle returns immediately). Resolves
   * as soon as there are no mutations for `quietMs`; returns fast on a static page,
   * hard-capped so a forever-animating page can't wedge it.
   */
  private async settleDom(page: Page): Promise<void> {
    await page.evaluate((quietMs: number, capMs: number) => new Promise<void>((resolve) => {
      const target = document.body;
      if (!target) { resolve(); return; }
      let quiet: ReturnType<typeof setTimeout>;
      const finish = (): void => { clearTimeout(quiet); clearTimeout(cap); observer.disconnect(); resolve(); };
      const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(finish, quietMs); });
      observer.observe(target, { attributes: true, characterData: true, childList: true, subtree: true });
      quiet = setTimeout(finish, quietMs);
      const cap = setTimeout(finish, capMs);
    }), 400, 4_000).catch(() => { /* page navigated away mid-wait */ });
  }

  async open(url: string): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    // goto RESOLVES on a 4xx/5xx (the error page loaded fine) — capture the
    // status so a 404/500 error page isn't surfaced as the requested content.
    const response = await page.goto(url, { timeout: this.timeout, waitUntil: "domcontentloaded" });
    this.lastHttpStatus = response?.status();
    await this.settleDom(page);
    return this.snapshot();
  }

  async snapshot(): Promise<PageSnapshot> {
    let snapshot = await this.captureSnapshot();
    for (let retry = 0; retry < SETTLE_RETRIES && looksUnsettled(snapshot); retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
      snapshot = await this.captureSnapshot();
    }
    // Consume the navigation status ONCE per observation — AFTER the settle-retry
    // loop, so a 4xx/5xx error page (no elements + stub text → looksUnsettled,
    // so it re-captures) doesn't drop the status on the retry. A later bare
    // snapshot() then carries no stale status.
    this.lastHttpStatus = undefined;
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
        "[role=combobox], [role=searchbox], [role=checkbox], [role=radio], [role=menuitem], [role=tab], " +
        "[role=option], [role=switch], [aria-haspopup], [onclick]";
      // A form control's accessible name is its VISIBLE label, not its value/name
      // attr — the model says "Pro plan" / "Email" / "I agree", never "pro". Resolve
      // aria-labelledby → <label for> → wrapping <label>.
      const labelFor = (el: Element): string => {
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          const text = labelledby.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "").join(" ").trim();
          if (text) return text;
        }
        if (el.id) {
          const explicit = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (explicit?.textContent) return explicit.textContent;
        }
        return (el.closest("label") as HTMLElement | null)?.textContent ?? "";
      };
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
      const out: Array<{ ref: number; role: string; name: string; url?: string }> = [];
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
        // Disabled controls aren't actionable — listing them just lets the model
        // waste a turn clicking something the locator will reject. Skip them (the
        // page text still mentions them, so context isn't lost).
        if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
        const tag = el.tagName.toLowerCase();
        const htmlEl = el as HTMLElement & { value?: string };
        const isField = tag === "input" || tag === "textarea" || tag === "select";
        const name = (
          el.getAttribute("aria-label") ||
          (isField ? labelFor(el) : "") ||
          htmlEl.innerText ||
          htmlEl.value ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title") ||
          el.getAttribute("alt") ||
          ""
        ).trim().replace(/\s+/g, " ").slice(0, maxName);
        if (!name && !isField) continue;
        const role =
          el.getAttribute("role") ||
          (tag === "a" ? "link" : tag === "button" ? "button" : tag === "select" ? "combobox" : isField ? "textbox" : "button");
        // Collapse only TRULY redundant links — same text AND same href, which is
        // a responsive nav rendered twice. Distinct buttons/actions are NEVER
        // deduped: a per-row "Add to cart" or a repeated "View" must each stay
        // targetable (the model picks one by ordinal — "the second Add to cart").
        if (tag === "a" && name) {
          const key = `${name} ${el.getAttribute("href") || ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        el.setAttribute("data-muse-ref", String(ref));
        // A link's resolved absolute destination — `HTMLAnchorElement.href` is
        // already absolute (unlike the raw `href` attribute). Carried so the
        // model can report WHERE a link goes without having to click it.
        const anchor = el as HTMLAnchorElement;
        const url = tag === "a" && typeof anchor.href === "string" && anchor.href.length > 0 ? anchor.href : undefined;
        out.push(url ? { name, ref, role, url } : { name, ref, role });
        ref += 1;
      }
      return out;
    }, BROWSER_ELEMENT_CEILING, BROWSER_MAX_NAME)) as SnapshotElement[];
    this.lastElements = new Map(elements.map((element) => [element.ref, element]));
    // Surface a dialog that fired since the last observation (auto-accepted), then
    // clear it so it's reported exactly once.
    const dialog = this.lastDialog;
    this.lastDialog = undefined;
    // Read the navigation's HTTP status (set by open/back). NOT cleared here:
    // snapshot()'s settle-retry can re-capture the SAME navigation, so the status
    // is consumed once in snapshot() after the loop, not per capture.
    const httpStatus = this.lastHttpStatus;
    return {
      elements,
      text,
      title,
      url: this.lastUrl,
      ...(dialog ? { dialog } : {}),
      ...(httpStatus === undefined ? {} : { httpStatus })
    };
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
    await this.ensurePage();
    const { frame, selector } = await this.resolveRef(ref);
    // Locator (not a raw handle): auto-waits for visible/enabled/stable before
    // acting — the reliable-interaction pattern from the Puppeteer guide. Scoped
    // to the resolved frame so iframe-embedded controls work. Wrapped so a
    // target=_blank / window.open new tab is followed, and so a navigation to an
    // error page (404/500) surfaces its HTTP status like open/back.
    await this.withNavStatus(() => this.withNewTabFollow(() => frame.locator(selector).setTimeout(this.timeout).click()));
    const page = await this.ensurePage();
    await page.waitForNetworkIdle({ idleTime: 500, timeout: this.timeout }).catch(() => { /* page may not navigate */ });
    await this.settleDom(page);
    return this.snapshot();
  }

  async hover(ref: number): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    const { frame, selector } = await this.resolveRef(ref);
    // The pointer STAYS on the element after this, so a CSS :hover / mouseover
    // submenu rendered into the hovered subtree is observed AND remains clickable
    // (moving to a nested item keeps :hover true).
    await frame.locator(selector).setTimeout(this.timeout).hover();
    await this.settleDom(page);
    return this.snapshot();
  }

  async pressKey(key: BrowserKey): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    // Enter on a focused link/form can navigate or open a tab — follow it, and
    // capture an error-page status so an Enter-submit landing on a 404/500 is
    // flagged like open/back.
    await this.withNavStatus(() => this.withNewTabFollow(() => page.keyboard.press(key)));
    const active = await this.ensurePage();
    await this.settleDom(active);
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
      // A submit can navigate to an error page (a search that 500s) — capture
      // its status so the model isn't handed the error body as results.
      await this.withNavStatus(() => this.withNewTabFollow(() => page.keyboard.press("Enter")));
      const active = await this.ensurePage();
      await active.waitForNetworkIdle({ idleTime: 500, timeout: this.timeout }).catch(() => { /* may not navigate */ });
    }
    const current = await this.ensurePage();
    await this.settleDom(current);
    return this.snapshot();
  }

  async uploadFile(ref: number, path: string): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    const { frame, selector } = await this.resolveRef(ref);
    const handle = await frame.$(selector);
    if (!handle) {
      throw new Error(`no element with ref ${ref.toString()} on the current page — call browser_read again`);
    }
    // Fail-closed on a non-file element: setInputFiles is only meaningful on an
    // <input type=file>. Attaching a file to anything else is a no-op that would
    // leave the user thinking the file was attached — refuse it loudly instead,
    // AFTER the user already confirmed (the tool also resolves before the gate).
    const isFileInput = await handle.evaluate(
      (el) => el instanceof HTMLInputElement && el.type === "file"
    );
    if (!isFileInput) {
      await handle.dispose();
      throw new Error("the chosen element is not a file input — pick the page's file-attach control");
    }
    // The evaluate above PROVED this handle is an <input type=file>; narrow it
    // so puppeteer's uploadFile (typed for HTMLInputElement) accepts it.
    await (handle as ElementHandle<HTMLInputElement>).uploadFile(path);
    await this.settleDom(page);
    return this.snapshot();
  }

  async back(): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    const response = await page.goBack({ timeout: this.timeout, waitUntil: "domcontentloaded" }).catch(() => null);
    this.lastHttpStatus = response?.status();
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
    await this.settleDom(page);
    return this.snapshot();
  }

  async waitFor(condition: WaitCondition): Promise<WaitOutcome> {
    const page = await this.ensurePage();
    const selector = condition.selector?.trim();
    const text = condition.text?.trim();
    const requested = condition.timeoutMs;
    const bound = requested === undefined || !Number.isFinite(requested) ? WAIT_DEFAULT_MS : requested;
    // Keep the poll's own timeout under the CDP ceiling so the waitForFunction
    // roundtrip can't out-race protocolTimeout (that would throw a protocol
    // error instead of resolving as an honest no-match).
    const timeout = Math.min(Math.max(Math.trunc(bound), WAIT_MIN_MS), WAIT_MAX_MS, this.protocolTimeout - 1_000);
    let matched = true;
    try {
      // ONE waitForFunction handles both modes: a selector must match a VISIBLE
      // element (rect > 0, not display:none), or the substring must appear in
      // the body's innerText. Polling (not a static check) is what makes this
      // catch content that arrives AFTER the initial settle.
      await page.waitForFunction(
        (sel: string | null, needle: string | null) => {
          if (sel) {
            const el = document.querySelector(sel);
            if (!el) return false;
            const rect = (el as HTMLElement).getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }
          if (needle) return (document.body?.innerText ?? "").includes(needle);
          return true;
        },
        { polling: 200, timeout },
        selector ?? null,
        text ?? null
      );
    } catch {
      // TimeoutError (or page navigated away mid-wait): the condition never
      // held within the bound. Report it honestly rather than throwing — the
      // model gets matched=false plus the live page, not a fabricated success.
      matched = false;
    }
    await this.settleDom(page);
    return { matched, snapshot: await this.snapshot() };
  }

  async screenshot(path: string): Promise<{ readonly path: string }> {
    const page = await this.ensurePage();
    await page.screenshot({ path: path as `${string}.png` });
    return { path };
  }

  async screenshotBase64(): Promise<string> {
    const page = await this.ensurePage();
    return page.screenshot({ encoding: "base64", type: "png" }) as Promise<string>;
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
