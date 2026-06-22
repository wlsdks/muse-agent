import { isRecord } from "@muse/shared";
import { webWatchesFromConfig } from "@muse/proactivity";
import { parseHomeAlertChecks } from "@muse/domain-tools";

/**
 * Path-from-env resolver matching the empty-env-shadow
 * convention: a shell that pre-clears `MUSE_HOME=` / `MUSE_MCP_CONFIG=`
 * must NOT make the doctor stat the empty path and falsely report
 * `~/.muse` / `mcp.json` as missing. Treat empty / whitespace-only
 * env as "unset" and fall back to the documented default.
 */
export function resolveMuseEnvPath(raw: string | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function classifyMcpServersField(parsed: unknown): {
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
} {
  if (!isRecord(parsed)) {
    return { detail: "mcp.json root must be a JSON object", status: "fail" };
  }
  if (parsed.servers === undefined) {
    return { detail: "0 server(s) — no `servers` key in mcp.json", status: "warn" };
  }
  if (!Array.isArray(parsed.servers)) {
    return { detail: `\`servers\` must be an array (got ${parsed.servers === null ? "null" : typeof parsed.servers})`, status: "fail" };
  }
  const count = parsed.servers.length;
  return { detail: `${count.toString()} server(s) registered`, status: count > 0 ? "ok" : "warn" };
}

/**
 * Validate `MUSE_WEB_WATCH_CONFIG` (the "monitor this page, ping me
 * when X" JSON array). The daemon parses it FAIL-OPEN — a malformed
 * entry is silently dropped, so a user with one typo'd watch gets no
 * notice AND no error, the classic "why isn't it firing?" trap. This
 * surfaces the silent drop. Drives the REAL `webWatchesFromConfig`
 * parser (a no-op Chrome connection so `source: "chrome"` entries
 * count as valid rather than being dropped for lack of a live browser
 * here) so the count can't drift from what the daemon actually builds.
 * Returns `undefined` when unset / an empty array — nothing to report.
 */
export function classifyWebWatchConfig(raw: string | undefined): {
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
} | undefined {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { detail: "MUSE_WEB_WATCH_CONFIG is set but not valid JSON — no pages are being watched", status: "warn" };
  }
  if (!Array.isArray(parsed)) {
    return { detail: "MUSE_WEB_WATCH_CONFIG must be a JSON array — no pages are being watched", status: "warn" };
  }
  const total = parsed.length;
  if (total === 0) return undefined;
  const valid = webWatchesFromConfig(trimmed, { chromeConnection: { callTool: async () => undefined } }).length;
  if (valid === total) {
    return { detail: `${valid.toString()} page-watch(es) configured`, status: "ok" };
  }
  const dropped = total - valid;
  return {
    detail: `${dropped.toString()} of ${total.toString()} web-watch ${dropped === 1 ? "entry is" : "entries are"} invalid and skipped — check id/url/title/message/rule`,
    status: "warn"
  };
}

/**
 * Validate `MUSE_BRIEFING_HOME_ALERTS` (the "surface a home sensor in
 * my briefing when it's in an alert state" JSON array). Like the
 * web-watch config it's parsed FAIL-OPEN, so a typo'd entry (missing
 * entityId/label, an empty alertStates) is silently dropped and the
 * alert never appears in the briefing with no error. This surfaces the
 * silent drop. Drives the REAL `@muse/mcp` `parseHomeAlertChecks` so
 * the count can't drift from what the briefing daemon builds. Returns
 * `undefined` when unset / an empty array — nothing to report.
 */
export function classifyHomeAlertsConfig(raw: string | undefined): {
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
} | undefined {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { detail: "MUSE_BRIEFING_HOME_ALERTS is set but not valid JSON — no home alerts in the briefing", status: "warn" };
  }
  if (!Array.isArray(parsed)) {
    return { detail: "MUSE_BRIEFING_HOME_ALERTS must be a JSON array — no home alerts in the briefing", status: "warn" };
  }
  const total = parsed.length;
  if (total === 0) return undefined;
  const valid = parseHomeAlertChecks(trimmed).length;
  if (valid === total) {
    return { detail: `${valid.toString()} home-alert(s) configured`, status: "ok" };
  }
  const dropped = total - valid;
  return {
    detail: `${dropped.toString()} of ${total.toString()} home-alert ${dropped === 1 ? "entry is" : "entries are"} invalid and skipped — check entityId/label/alertStates`,
    status: "warn"
  };
}

export function resolveDoctorWatchIntervalMs(raw: string | undefined): number {
  const defaultMs = 5_000;
  if (!raw) return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  const seconds = Math.min(3600, Math.max(1, parsed));
  return Math.round(seconds * 1000);
}
