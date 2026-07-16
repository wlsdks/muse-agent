/**
 * Web-watch trigger detection (P21). The core of "monitor this page
 * and ping me when X" — given the previous and current text snapshot
 * of a page (e.g. from Chrome DevTools MCP `take_snapshot`), decide
 * whether the watch condition just became true. Edge-triggered so a
 * standing condition doesn't re-fire every poll.
 *
 * Pure string logic — no deps; the polling tick (snapshot via the
 * MCP tool + deliver a proactive notice) wires this in.
 */
import { promises as fs } from "node:fs";

import { fetchWithRetry, type RetryOptions } from "@muse/mcp-shared";
import type { ProactiveNoticeSink } from "./proactive-notice-loop.js";

export interface WatchRule {
  /** Fire when the snapshot NEWLY contains this (wasn't there before). */
  readonly appears?: string;
  /** Fire when the snapshot NEWLY lacks this (was there before). */
  readonly disappears?: string;
  /** Fire on ANY content change vs the previous snapshot. */
  readonly onAnyChange?: boolean;
  /** Case-insensitive substring matching. Default true. */
  readonly caseInsensitive?: boolean;
  /**
   * Narrow the snapshot to the region of interest before matching — a
   * regex applied to BOTH snapshots; capture group 1 if present, else
   * the whole match. Real pages carry noise (ads, timestamps) that
   * would make `onAnyChange` fire every poll; an `extract` of e.g.
   * `Status: (\w+)` watches only that value. No match → empty region;
   * an invalid regex fails open to the whole text.
   */
  readonly extract?: string;
  /**
   * Fire when the number parsed from the (extracted) region NEWLY drops
   * below this threshold — the price-drop alert ("ping me when it's
   * under $40"). Edge-triggered: fires once when it crosses below, not
   * every poll while it stays below. No parseable number → no fire.
   */
  readonly below?: number;
  /** Mirror of `below` — fire when the parsed number NEWLY exceeds this. */
  readonly above?: number;
}

export interface WatchTrigger {
  readonly triggered: boolean;
  readonly reason?: string;
}

function includesText(haystack: string, needle: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? haystack.toLowerCase().includes(needle.toLowerCase()) : haystack.includes(needle);
}

function applyExtract(text: string, pattern: string | undefined): string {
  if (pattern === undefined || pattern.length === 0) {
    return text;
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return text;
  }
  const match = re.exec(text);
  if (match === null) {
    return "";
  }
  return match[1] ?? match[0];
}

function parseWatchNumber(text: string): number | undefined {
  const match = /-?\d[\d,]*(?:\.\d+)?/.exec(text);
  if (match === null) {
    return undefined;
  }
  const value = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

/**
 * `previousText` is undefined on the first observation (no baseline):
 * `appears` fires if the term is present now (the user learns it's
 * there); `disappears` / `onAnyChange` need a baseline and stay quiet.
 */
export function detectWatchTrigger(
  previousText: string | undefined,
  currentText: string,
  rule: WatchRule
): WatchTrigger {
  const caseInsensitive = rule.caseInsensitive !== false;
  const current = applyExtract(currentText, rule.extract);
  const previous = previousText === undefined ? undefined : applyExtract(previousText, rule.extract);

  if (rule.appears !== undefined && rule.appears.length > 0) {
    const presentNow = includesText(current, rule.appears, caseInsensitive);
    const presentBefore = previous !== undefined && includesText(previous, rule.appears, caseInsensitive);
    if (presentNow && !presentBefore) {
      return { reason: `appeared: ${rule.appears}`, triggered: true };
    }
  }

  if (rule.disappears !== undefined && rule.disappears.length > 0) {
    const presentNow = includesText(current, rule.disappears, caseInsensitive);
    const presentBefore = previous !== undefined && includesText(previous, rule.disappears, caseInsensitive);
    if (presentBefore && !presentNow) {
      return { reason: `gone: ${rule.disappears}`, triggered: true };
    }
  }

  if (rule.below !== undefined) {
    const valueNow = parseWatchNumber(current);
    const valueBefore = previous === undefined ? undefined : parseWatchNumber(previous);
    const belowNow = valueNow !== undefined && valueNow < rule.below;
    const belowBefore = valueBefore !== undefined && valueBefore < rule.below;
    if (belowNow && !belowBefore) {
      return { reason: `below ${rule.below.toString()}: ${valueNow!.toString()}`, triggered: true };
    }
  }

  if (rule.above !== undefined) {
    const valueNow = parseWatchNumber(current);
    const valueBefore = previous === undefined ? undefined : parseWatchNumber(previous);
    const aboveNow = valueNow !== undefined && valueNow > rule.above;
    const aboveBefore = valueBefore !== undefined && valueBefore > rule.above;
    if (aboveNow && !aboveBefore) {
      return { reason: `above ${rule.above.toString()}: ${valueNow!.toString()}`, triggered: true };
    }
  }

  if (rule.onAnyChange === true && previous !== undefined && previous !== current) {
    return { reason: "content changed", triggered: true };
  }

  return { triggered: false };
}

export interface WebWatch {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly rule: WatchRule;
  /** Fetch the current page text — in production a Chrome DevTools MCP `take_snapshot` call. */
  readonly snapshot: () => Promise<string | undefined> | string | undefined;
}

export interface WebWatchRunner {
  tick(): Promise<{ readonly delivered: number }>;
}

/**
 * Stateful web-watch runner for a polling tick. Each tick snapshots
 * every watch's page, runs {@link detectWatchTrigger} against that
 * watch's previous snapshot, and delivers a proactive notice on a
 * trigger. Holds the per-watch baseline so the detector is
 * edge-triggered across ticks. A failed snapshot is skipped WITHOUT
 * losing the last good baseline. Read-only: a watch never acts.
 */
export function createWebWatchRunner(options: {
  readonly watches: readonly WebWatch[];
  readonly sink: ProactiveNoticeSink;
}): WebWatchRunner {
  const previous = new Map<string, string>();
  return {
    async tick(): Promise<{ readonly delivered: number }> {
      let delivered = 0;
      for (const watch of options.watches) {
        let current: string | undefined;
        try {
          current = await watch.snapshot();
        } catch {
          current = undefined;
        }
        if (current === undefined) {
          continue;
        }
        const trigger = detectWatchTrigger(previous.get(watch.id), current, watch.rule);
        if (!trigger.triggered) {
          previous.set(watch.id, current);
          continue;
        }
        try {
          await options.sink.deliver({
            kind: "web-watch",
            text: trigger.reason ? `${watch.message} (${trigger.reason})` : watch.message,
            title: watch.title
          });
          // Advance the baseline ONLY after a successful send. If delivery
          // fails (a messaging blip, retries exhausted), the edge must
          // NOT be consumed — leaving the old baseline re-fires it next
          // tick rather than silently losing the notice forever.
          previous.set(watch.id, current);
          delivered += 1;
        } catch {
          // This watch's notice didn't go out; other watches still run.
        }
      }
      return { delivered };
    }
  };
}

const RULE_FIELDS = ["appears", "disappears", "extract"] as const;
const MAX_WATCH_RULE_TEXT_LENGTH = 1_000;

/**
 * Snapshot source for a PUBLIC web page: an HTTP GET (retry-hardened
 * for transient 429/5xx). Non-intrusive — unlike driving the user's
 * logged-in browser, it doesn't hijack their active tab. Returns the
 * body text, or `undefined` on a permanent failure (the runner then
 * skips that watch without losing its baseline). Optional `headers`
 * (a copied Cookie / Authorization) let it watch a page behind the
 * user's session — non-intrusive, no browser hijack.
 */
export function createHttpSnapshot(
  url: string,
  options: { readonly fetchImpl?: typeof globalThis.fetch; readonly retryOptions?: RetryOptions; readonly headers?: Record<string, string> } = {}
): () => Promise<string | undefined> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const retryOptions: RetryOptions = options.headers
    ? {
        ...(options.retryOptions ?? {}),
        init: {
          ...(options.retryOptions?.init ?? {}),
          headers: { ...(options.retryOptions?.init?.headers as Record<string, string> | undefined), ...options.headers }
        }
      }
    : options.retryOptions ?? {};
  return async () => {
    try {
      const response = await fetchWithRetry(fetchImpl, url, retryOptions);
      if (!response.ok) {
        return undefined;
      }
      return await response.text();
    } catch {
      return undefined;
    }
  };
}

/**
 * Snapshot source for a LOCAL file: read its UTF-8 text. Lets a watch
 * monitor a log or file on disk ("ping me when ERROR appears in app.log",
 * "tell me when this file changes") through the same edge-triggered runner
 * as web/chrome watches. Returns the text, or `undefined` when the file is
 * missing/unreadable (the runner then skips that watch without losing its
 * baseline). The path comes from the user's OWN watch config, so no
 * allowlist is needed (unlike the SSRF-bounded HTTP fetcher). Read-only.
 *
 * Local-file/log monitoring parallels the competitors' watch/monitor skills
 * (Hermes/OpenClaw), reusing Muse's own web-watch runner — no third-party
 * code reimplemented.
 */
export function createFileSnapshot(path: string): () => Promise<string | undefined> {
  return async () => {
    try {
      return await fs.readFile(path, "utf8");
    } catch {
      return undefined;
    }
  };
}

/** Minimal Chrome DevTools MCP connection seam — `callTool` is all a snapshot needs. */
export interface ChromeSnapshotConnection {
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Snapshot source that reads a page through the user's REAL logged-in
 * Chrome via the Chrome DevTools MCP connection: navigate the attached
 * tab to `url`, then `take_snapshot` its text. This is what lets a
 * watch monitor a page behind the user's session (an order status, a
 * private dashboard, a logged-in ticket) that a plain HTTP GET can't
 * see. UNLIKE {@link createHttpSnapshot} it drives the real browser
 * tab — use it only when the page genuinely requires the authenticated
 * session. Read-only: navigate + snapshot, never a state-changing
 * action. Returns the page text, or `undefined` on any failure (the
 * runner then skips that watch without losing its baseline).
 */
export function createChromeSnapshot(
  connection: ChromeSnapshotConnection,
  url: string
): () => Promise<string | undefined> {
  return async () => {
    try {
      await connection.callTool("navigate_page", { url });
      const result = await connection.callTool("take_snapshot", {});
      return typeof result === "string" && result.trim().length > 0 ? result : undefined;
    } catch {
      return undefined;
    }
  };
}

function parseHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key) && !/[\u0000-\u001f\u007f]/u.test(value)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse a JSON array of watch specs from config and build runnable
 * `WebWatch`es. Each entry needs a non-empty `id`, string
 * `title`/`message`, a `rule` with at least one condition (`appears` /
 * `disappears` / `onAnyChange` / numeric `below` / `above`), and a
 * locator that depends on `source`: a `"file"` entry needs a local
 * `path`; `"chrome"` and the default HTTP source need a `url`.
 * Fail-open: malformed JSON / non-array / an invalid entry is skipped.
 */
export function webWatchesFromConfig(
  raw: string,
  options: {
    readonly fetchImpl?: typeof globalThis.fetch;
    readonly retryOptions?: RetryOptions;
    /** When set, an entry with `"source": "chrome"` reads via the user's logged-in Chrome instead of HTTP. */
    readonly chromeConnection?: ChromeSnapshotConnection;
  } = {}
): WebWatch[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: WebWatch[] = [];
  const ids = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    // The locator field depends on the source: a file watch points at a local
    // PATH, web/chrome watches at a URL.
    const source = e.source === "file" ? "file" : e.source === "chrome" ? "chrome" : "http";
    const locator = source === "file" ? e.path : e.url;
    if (typeof e.id !== "string" || e.id.length === 0 || ids.has(e.id) || typeof locator !== "string" || locator.length === 0) {
      continue;
    }
    if (typeof e.title !== "string" || typeof e.message !== "string") {
      continue;
    }
    const rule = parseWatchRule(e.rule);
    if (rule === undefined) {
      continue;
    }
    if (source === "chrome" && !options.chromeConnection) {
      // A chrome-source watch needs a live connection to drive — skip
      // it (rather than silently downgrade to HTTP, which can't see the
      // authenticated page the user asked to watch).
      continue;
    }
    const headers = parseHeaders(e.headers);
    const httpOptions = {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.retryOptions ? { retryOptions: options.retryOptions } : {}),
      ...(headers ? { headers } : {})
    };
    out.push({
      id: e.id,
      message: e.message,
      rule,
      snapshot:
        source === "file"
          ? createFileSnapshot(locator)
          : source === "chrome"
            ? createChromeSnapshot(options.chromeConnection!, locator)
            : createHttpSnapshot(locator, httpOptions),
      title: e.title
    });
    ids.add(e.id);
  }
  return out;
}

/**
 * Parse a `WatchRule` from untrusted config. Returns `undefined` when
 * the value isn't an object or carries NO firing condition (`appears` /
 * `disappears` / `onAnyChange` / numeric `below` / `above`) — `extract`
 * and `caseInsensitive` are modifiers, not conditions. Shared by every
 * watch source (web pages, Home Assistant entities) so their rule
 * semantics can't drift.
 */
export function parseWatchRule(raw: unknown): WatchRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const ruleObj = raw as Record<string, unknown>;
  const rule: { appears?: string; disappears?: string; extract?: string; onAnyChange?: boolean; caseInsensitive?: boolean; below?: number; above?: number } = {};
  for (const field of RULE_FIELDS) {
    if (typeof ruleObj[field] === "string" && (ruleObj[field] as string).length > 0 && (ruleObj[field] as string).length <= MAX_WATCH_RULE_TEXT_LENGTH) {
      rule[field] = ruleObj[field] as string;
    }
  }
  if (ruleObj.onAnyChange === true) {
    rule.onAnyChange = true;
  }
  if (ruleObj.caseInsensitive === false) {
    rule.caseInsensitive = false;
  }
  if (typeof ruleObj.below === "number" && Number.isFinite(ruleObj.below)) {
    rule.below = ruleObj.below;
  }
  if (typeof ruleObj.above === "number" && Number.isFinite(ruleObj.above)) {
    rule.above = ruleObj.above;
  }
  if (
    rule.appears === undefined && rule.disappears === undefined
    && rule.onAnyChange !== true && rule.below === undefined && rule.above === undefined
  ) {
    return undefined;
  }
  return rule;
}
