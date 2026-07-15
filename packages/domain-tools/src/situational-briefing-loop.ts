/**
 * Deliver the synthesised situational briefing on the real
 * channel, once per situation-window. Composes the
 * contract-faithful messaging-send path with a minimal
 * last-fired-at dedupe sidecar so a JARVIS briefs the situation
 * once, not on every tick.
 *
 * `now` / the imminent list / the registry are injected so the
 * delivery is exercised over a real provider request shape with
 * only the HTTP boundary faked. The setInterval daemon that drives
 * this lives in apps/api, mirroring the proactive / reminder ticks.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import type { MessagingProviderRegistry } from "@muse/messaging";

import { sendWithRetry } from "@muse/mcp-shared";
import { readObjectives } from "@muse/stores";
import { composeSituationalBriefing, type BriefingImminent } from "@muse/proactivity";
import { unreadBriefingLine, type EmailProvider } from "./email-provider.js";
import { resolveWeatherLine, type WeatherProvider } from "./weather.js";

const DEFAULT_WINDOW_MS = 4 * 60 * 60_000;

export interface RunDueSituationalBriefingOptions {
  readonly objectivesFile: string;
  readonly imminent: readonly BriefingImminent[];
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  /** Last-fired-at dedupe sidecar. Required — without it every tick re-briefs. */
  readonly sidecarFile: string;
  /** Suppress a re-brief within this window of the last one. Default 4h. */
  readonly windowMs?: number;
  readonly now?: () => Date;
  /**
   * Optional weather grounding. When both are set AND the briefing
   * already has something to say, the current weather for
   * `weatherLocation` is fetched and added as a supplementary line.
   * Fail-soft: a lookup error omits the line, never breaks the brief.
   */
  readonly weatherProvider?: WeatherProvider;
  readonly weatherLocation?: string;
  /**
   * Optional inbox grounding. When set AND the briefing already has
   * something to say, recent inbox messages are fetched and an
   * unread digest is added as a supplementary line. Fail-soft.
   */
  readonly emailProvider?: EmailProvider;
  readonly emailLimit?: number;
  /**
   * Optional predicate marking an unread sender as a known contact, so
   * the inbox line surfaces mail from people you KNOW first (flagged
   * "★"). Fail-soft alongside the rest of the inbox resolution.
   */
  readonly inboxKnownSender?: (from: string) => boolean;
  /**
   * Optional knowledge enricher. When set AND the briefing has an
   * imminent item, it is called with the top item's title to surface
   * a related note/task the user already wrote ("prep: bring the Q3
   * deck") as a supplementary line. Fail-soft: a thrown / empty
   * lookup omits the line, never breaks the brief.
   */
  readonly relatedKnowledge?: (query: string) => Promise<string | undefined> | string | undefined;
  /**
   * Optional home-alert resolver. When set AND the briefing already has
   * something to say, it surfaces noteworthy home states (a door left
   * unlocked) as a supplementary line. Same posture as weather/inbox;
   * fail-soft: a thrown / empty lookup omits the line.
   */
  readonly homeAlert?: () => Promise<string | undefined> | string | undefined;
  /**
   * Optional upcoming-birthdays resolver. When set AND the briefing has
   * content, surfaces a "Sarah today; Bob in 3 days" line. Fail-soft;
   * empty / thrown lookup omits the line.
   */
  readonly birthdayLine?: () => Promise<string | undefined> | string | undefined;
  /**
   * Optional due-tasks resolver. When set AND the briefing has content,
   * surfaces a "Buy milk (overdue); Pay rent (today)" line. Fail-soft.
   */
  readonly tasksDueLine?: () => Promise<string | undefined> | string | undefined;
  /**
   * Optional "shape of the day" free/busy resolver. When set AND the
   * briefing has content, surfaces a "free after 16:00" / "booked solid
   * the rest of today" line. Fail-soft.
   */
  readonly availabilityLine?: () => Promise<string | undefined> | string | undefined;
}

export interface RunDueSituationalBriefingSummary {
  readonly delivered: number;
  readonly reason?: "nothing-to-say" | "in-window";
}

async function readLastFiredAt(file: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { lastFiredAt?: unknown };
    const ms = typeof parsed.lastFiredAt === "string" ? Date.parse(parsed.lastFiredAt) : Number.NaN;
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

async function writeLastFiredAt(file: string, iso: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ lastFiredAt: iso }, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

async function resolveInboxLine(
  provider: EmailProvider,
  limit?: number,
  isKnownSender?: (from: string) => boolean
): Promise<string | undefined> {
  try {
    return unreadBriefingLine(
      await provider.listRecent(limit && limit > 0 ? limit : 10),
      isKnownSender ? { isKnownSender } : {}
    );
  } catch {
    return undefined;
  }
}

async function resolveRelatedLine(
  enrich: (query: string) => Promise<string | undefined> | string | undefined,
  imminent: readonly BriefingImminent[]
): Promise<string | undefined> {
  const top = [...imminent]
    .filter((item) => !Number.isNaN(item.startsAt.getTime()))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
  if (!top) {
    return undefined;
  }
  try {
    const line = await enrich(top.title);
    return line && line.trim().length > 0 ? line : undefined;
  } catch {
    return undefined;
  }
}

async function resolveLineSafely(
  resolve: () => Promise<string | undefined> | string | undefined
): Promise<string | undefined> {
  try {
    const line = await resolve();
    return line && line.trim().length > 0 ? line : undefined;
  } catch {
    return undefined;
  }
}

export async function runDueSituationalBriefing(
  options: RunDueSituationalBriefingOptions
): Promise<RunDueSituationalBriefingSummary> {
  const now = options.now ?? (() => new Date());
  const windowMs = typeof options.windowMs === "number" && Number.isFinite(options.windowMs)
    ? options.windowMs
    : DEFAULT_WINDOW_MS;
  const nowDate = now();

  const objectives = await readObjectives(options.objectivesFile);
  const hasContent = options.imminent.length > 0
    || objectives.some((o) => o.status === "active" || o.status === "escalated");
  // Only sense weather when there is already something to brief — it is
  // supplementary context, never a trigger, so an empty tick costs no
  // HTTP call.
  const weather = hasContent && options.weatherProvider && options.weatherLocation
    ? await resolveWeatherLine(options.weatherProvider, options.weatherLocation)
    : undefined;
  // Same posture as weather: only sense the inbox when there is
  // already something to brief; a lookup error omits the line.
  const inbox = hasContent && options.emailProvider
    ? await resolveInboxLine(options.emailProvider, options.emailLimit, options.inboxKnownSender)
    : undefined;
  const related = hasContent && options.relatedKnowledge && options.imminent.length > 0
    ? await resolveRelatedLine(options.relatedKnowledge, options.imminent)
    : undefined;
  const home = hasContent && options.homeAlert
    ? await resolveLineSafely(options.homeAlert)
    : undefined;
  const birthdays = hasContent && options.birthdayLine
    ? await resolveLineSafely(options.birthdayLine)
    : undefined;
  const tasksDue = hasContent && options.tasksDueLine
    ? await resolveLineSafely(options.tasksDueLine)
    : undefined;
  const availability = hasContent && options.availabilityLine
    ? await resolveLineSafely(options.availabilityLine)
    : undefined;
  const text = composeSituationalBriefing({
    imminent: options.imminent,
    now: nowDate,
    objectives,
    ...(weather ? { weather } : {}),
    ...(inbox ? { inbox } : {}),
    ...(related ? { related } : {}),
    ...(home ? { home } : {}),
    ...(birthdays ? { birthdays } : {}),
    ...(tasksDue ? { tasksDue } : {}),
    ...(availability ? { availability } : {})
  });
  if (!text) {
    return { delivered: 0, reason: "nothing-to-say" };
  }

  const lastFiredMs = await readLastFiredAt(options.sidecarFile);
  if (lastFiredMs !== undefined && nowDate.getTime() - lastFiredMs < windowMs) {
    return { delivered: 0, reason: "in-window" };
  }

  await sendWithRetry(options.messagingRegistry, options.providerId, {
    destination: options.destination,
    text
  });
  await writeLastFiredAt(options.sidecarFile, nowDate.toISOString());
  return { delivered: 1 };
}
