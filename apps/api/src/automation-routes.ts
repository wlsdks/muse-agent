/**
 * `GET /api/automation/upcoming` — the Automation view's first-thing-you-see
 * aggregator: what Muse will do NEXT (digest, scheduled jobs, next
 * reminder) and how much unasked-interruption room is left this hour/day.
 * Read-only, grounded 100% in real server state — no model call, no
 * synthesized text.
 *
 * Every section is resolved independently and swallows its own failure
 * (missing/corrupt store → null/[]) so one broken sidecar never 500s the
 * whole endpoint — same posture as `today-routes.ts`.
 */

import {
  computeNextRunAt,
  type ScheduledJob
} from "@muse/scheduler";
import {
  collectDeliveryQueueSnapshot,
  parseBoolean,
  resolveProactiveMessagingRoute,
  type DeliveryQueueSnapshot,
  type MessagingRouteResolution
} from "@muse/autoconfigure";
import type { MessagingProviderRegistry } from "@muse/messaging";
import { DEFAULT_DIGEST_HOUR, readInterruptionBudgetStatus, type InterruptionBudgetStatus } from "@muse/proactivity";
import { compareRemindersByDueAt, readInterruptionLedger, readReminders } from "@muse/stores";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import { resolveInterruptionBudgetWiring } from "./tick-daemons.js";
import type { ChannelDaemonStatus } from "./channel-daemon-supervisor.js";
import type { SchedulerRouteScheduler } from "./scheduler-routes.js";
import type { ServerOptions } from "./server.js";
import type { BriefingRuntimeStatus } from "./briefing-runtime-status.js";
import type { DigestRuntimeStatus } from "./digest-runtime-status.js";
import type { FollowupRuntimeStatus } from "./followup-runtime-status.js";
import type { ProactiveRuntimeStatus } from "./proactive-runtime-status.js";
import type { ReminderRuntimeStatus } from "./reminder-runtime-status.js";
import type { PatternRuntimeStatus } from "./pattern-runtime-status.js";
import { sanitizeMessagingRouteReceipt } from "./messaging-route-receipt.js";

const MAX_UPCOMING_JOBS = 5;
const MAX_DELIVERY_QUEUE_COUNT = 9_999;
const MAX_DELIVERY_QUEUE_AGE_MS = 1000 * 60 * 60 * 24 * 365 * 100;
const MAX_CHANNEL_RUNTIME_COUNT = 9_999;
const CHANNEL_DAEMON_KINDS = [
  "telegram-poll",
  "matrix-sync",
  "inbound-reply",
  "matrix-inbound-reply",
  "slack-poll",
  "discord-poll"
] as const;

type ChannelDaemonKind = (typeof CHANNEL_DAEMON_KINDS)[number];
type ChannelRuntimeStatus = "observed" | "degraded" | "unconfigured";

interface ChannelRuntimeDaemon {
  readonly kind: ChannelDaemonKind;
  readonly running: boolean;
  readonly hasError: boolean;
  readonly lastIngestCount: number | null;
  readonly lastIngestAtIso: string | null;
  readonly lastErrorAtIso: string | null;
}

interface ChannelRuntime {
  readonly status: ChannelRuntimeStatus;
  readonly daemons: readonly ChannelRuntimeDaemon[];
}

export interface AutomationRoutesGate {
  readonly authService: ServerOptions["authService"];
  /** Process env the digest + interruption-budget config is read from. */
  readonly env: NodeJS.ProcessEnv;
  readonly localOnly?: boolean;
  readonly scheduler?: SchedulerRouteScheduler;
  readonly remindersFile?: string;
  /** The live registry and pairing file used by daemon auto-routing. */
  readonly messagingRegistry?: MessagingProviderRegistry;
  readonly channelOwnersFile?: string;
  /** Read-only in-memory status from the API situational-briefing daemon, if it has ticked. */
  readonly briefingRuntimeStatus?: () => BriefingRuntimeStatus | null;
  /** Read-only in-memory status from the API digest daemon, if it has ticked. */
  readonly digestRuntimeStatus?: () => DigestRuntimeStatus | null;
  /** Read-only in-memory status from the API follow-up daemon, if it has ticked. */
  readonly followupRuntimeStatus?: () => FollowupRuntimeStatus | null;
  /** Read-only in-memory status from the API proactive daemon, if it has ticked. */
  readonly proactiveRuntimeStatus?: () => ProactiveRuntimeStatus | null;
  /** Read-only in-memory status from the API reminder daemon, if it has ticked. */
  readonly reminderRuntimeStatus?: () => ReminderRuntimeStatus | null;
  /** Read-only in-memory status from the API pattern daemon, if it has ticked. */
  readonly patternRuntimeStatus?: () => PatternRuntimeStatus | null;
  /** Read-only live status from the channel-daemon supervisor. */
  readonly channelDaemonStatus?: () => Readonly<Record<string, ChannelDaemonStatus>>;
}

interface UpcomingDigest {
  readonly enabled: boolean;
  readonly hour: number;
  readonly nextAtIso: string;
}

interface UpcomingScheduledJob {
  readonly id: string;
  readonly label: string;
  readonly nextRunAtIso: string | null;
}

interface UpcomingReminder {
  readonly id: string;
  readonly text: string;
  readonly dueAtIso: string;
}

interface UpcomingDeliveryQueueBucket {
  readonly count: number;
  readonly oldestAgeMs: number | null;
}

interface UpcomingDeliveryQueueSnapshot {
  readonly generatedAt: string;
  readonly pendingDrafts: UpcomingDeliveryQueueBucket;
  readonly followups: {
    readonly overdue: UpcomingDeliveryQueueBucket;
    readonly scheduled: UpcomingDeliveryQueueBucket;
  };
  readonly reminders: {
    readonly overdue: UpcomingDeliveryQueueBucket;
    readonly scheduled: UpcomingDeliveryQueueBucket;
  };
  readonly status: "observed" | "unverified";
}

export type GatewayRouteStatus = MessagingRouteResolution;

export interface AutomationUpcomingResponse {
  readonly digest: UpcomingDigest | null;
  readonly briefingRuntime: BriefingRuntimeStatus | null;
  readonly digestRuntime: DigestRuntimeStatus | null;
  readonly followupRuntime: FollowupRuntimeStatus | null;
  readonly proactiveRuntime: ProactiveRuntimeStatus | null;
  readonly reminderRuntime: ReminderRuntimeStatus | null;
  readonly patternRuntime: PatternRuntimeStatus | null;
  readonly budget: InterruptionBudgetStatus | null;
  readonly scheduledJobs: readonly UpcomingScheduledJob[];
  readonly nextReminder: UpcomingReminder | null;
  readonly gateway: GatewayRouteStatus;
  readonly deliveryQueueSnapshot: UpcomingDeliveryQueueSnapshot;
  readonly channelRuntime: ChannelRuntime;
}

export function registerAutomationRoutes(server: FastifyInstance, gate: AutomationRoutesGate): void {
  server.get("/api/automation/upcoming", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }

    const now = new Date();
    const gateway = await resolveGatewayRouteStatus(gate).catch(() => unavailableGatewayRouteStatus(gate));
    const [digest, budget, scheduledJobs, nextReminder, deliveryQueueSnapshot] = await Promise.all([
      resolveDigestStatus(gate.env, now, gateway),
      resolveBudgetStatus(gate.env, now).catch(() => null),
      resolveScheduledJobs(gate.scheduler, now).catch(() => []),
      resolveNextReminder(gate.remindersFile).catch(() => null),
      collectDeliveryQueueSnapshot({ env: gate.env }).then(projectDeliveryQueueSnapshot)
    ]);

    const digestRuntime = projectDigestRuntimeStatus(gate.digestRuntimeStatus?.() ?? null);
    const briefingRuntime = projectBriefingRuntimeStatus(gate.briefingRuntimeStatus?.() ?? null);
    const followupRuntime = gate.followupRuntimeStatus?.() ?? null;
    const proactiveRuntime = projectProactiveRuntimeStatus(gate.proactiveRuntimeStatus?.() ?? null);
    const reminderRuntime = gate.reminderRuntimeStatus?.() ?? null;
    const patternRuntime = gate.patternRuntimeStatus?.() ?? null;
    const channelRuntime = resolveChannelRuntime(gate);
    const response: AutomationUpcomingResponse = {
      budget,
      deliveryQueueSnapshot,
      digest,
      briefingRuntime,
      digestRuntime,
      followupRuntime,
      gateway,
      nextReminder,
      patternRuntime,
      proactiveRuntime,
      reminderRuntime,
      scheduledJobs,
      channelRuntime
    };
    return response;
  });
}

function resolveChannelRuntime(gate: AutomationRoutesGate): ChannelRuntime {
  let statuses: Readonly<Record<string, ChannelDaemonStatus>>;
  try {
    statuses = gate.channelDaemonStatus?.() ?? {};
  } catch {
    statuses = {};
  }

  const daemons = CHANNEL_DAEMON_KINDS.flatMap((kind) => {
    const status = statuses[kind];
    return status ? [projectChannelRuntimeDaemon(kind, status)] : [];
  });
  return {
    daemons,
    status: daemons.length === 0 ? "unconfigured" : daemons.some((daemon) => daemon.hasError) ? "degraded" : "observed"
  };
}

function projectDigestRuntimeStatus(status: DigestRuntimeStatus | null): DigestRuntimeStatus | null {
  if (!status) return null;
  return {
    lastDecision: status.lastDecision,
    lastErrorCount: status.lastErrorCount,
    lastItemCount: status.lastItemCount,
    lastObservedAtIso: status.lastObservedAtIso,
    lastRoute: sanitizeMessagingRouteReceipt(status.lastRoute)
  };
}

function projectBriefingRuntimeStatus(status: BriefingRuntimeStatus | null): BriefingRuntimeStatus | null {
  if (!status) return null;
  return {
    lastDecision: status.lastDecision,
    lastDeliveredCount: status.lastDeliveredCount,
    lastErrorCount: status.lastErrorCount,
    lastImminentCount: status.lastImminentCount,
    lastObservedAtIso: status.lastObservedAtIso,
    lastRoute: sanitizeMessagingRouteReceipt(status.lastRoute)
  };
}

function projectProactiveRuntimeStatus(status: ProactiveRuntimeStatus | null): ProactiveRuntimeStatus | null {
  if (!status) return null;
  return {
    lastDecision: status.lastDecision,
    lastErrorCount: status.lastErrorCount,
    lastFiredCount: status.lastFiredCount,
    lastImminentCount: status.lastImminentCount,
    lastObservedAtIso: status.lastObservedAtIso,
    lastRoute: sanitizeMessagingRouteReceipt(status.lastRoute),
    lastSuppressedCount: status.lastSuppressedCount,
    ...(status.sessionLockedUntilIso ? { sessionLockedUntilIso: status.sessionLockedUntilIso } : {})
  };
}

function projectChannelRuntimeDaemon(kind: ChannelDaemonKind, status: ChannelDaemonStatus): ChannelRuntimeDaemon {
  const hasError = typeof status.lastError === "string";
  return {
    hasError,
    kind,
    lastErrorAtIso: hasError ? safeIso(status.lastErrorAtIso) : null,
    lastIngestAtIso: safeIso(status.lastIngestAtIso),
    lastIngestCount: boundedChannelRuntimeCount(status.lastIngestCount),
    running: status.running
  };
}

function boundedChannelRuntimeCount(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.min(MAX_CHANNEL_RUNTIME_COUNT, Math.max(0, Math.trunc(value)));
}

function safeIso(value: string | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function projectDeliveryQueueSnapshot(snapshot: DeliveryQueueSnapshot): UpcomingDeliveryQueueSnapshot {
  return {
    followups: {
      overdue: projectDeliveryQueueBucket(snapshot.followups.overdue),
      scheduled: projectDeliveryQueueBucket(snapshot.followups.scheduled)
    },
    generatedAt: safeGeneratedAt(snapshot.generatedAt),
    pendingDrafts: projectDeliveryQueueBucket(snapshot.pendingDrafts),
    reminders: {
      overdue: projectDeliveryQueueBucket(snapshot.reminders.overdue),
      scheduled: projectDeliveryQueueBucket(snapshot.reminders.scheduled)
    },
    status: snapshot.status
  };
}

function projectDeliveryQueueBucket(bucket: { readonly count: number; readonly oldestAgeMs: number | null }): UpcomingDeliveryQueueBucket {
  return {
    count: boundedDeliveryQueueCount(bucket.count),
    oldestAgeMs: boundedDeliveryQueueAge(bucket.oldestAgeMs)
  };
}

function boundedDeliveryQueueCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_DELIVERY_QUEUE_COUNT, Math.max(0, Math.trunc(value)));
}

function boundedDeliveryQueueAge(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(MAX_DELIVERY_QUEUE_AGE_MS, Math.max(0, Math.trunc(value)));
}

function safeGeneratedAt(value: string): string {
  return Number.isFinite(Date.parse(value)) ? value : "unavailable";
}

async function resolveGatewayRouteStatus(gate: AutomationRoutesGate): Promise<GatewayRouteStatus> {
  return resolveProactiveMessagingRoute(gate.env, {
    // API compatibility for the legacy situational-briefing pair: canonical
    // MUSE_PROACTIVE_* wins; MUSE_BRIEFING_* is used only when neither
    // canonical key is present. The briefing tick uses the same option.
    allowBriefingFallback: true,
    ...(gate.channelOwnersFile ? { ownersFile: gate.channelOwnersFile } : {}),
    ...(gate.localOnly !== undefined ? { localOnly: gate.localOnly } : {}),
    ...(gate.messagingRegistry ? { registry: gate.messagingRegistry } : {})
  });
}

function unavailableGatewayRouteStatus(gate: AutomationRoutesGate): GatewayRouteStatus {
  return resolveProactiveMessagingRoute(gate.env, {
    allowBriefingFallback: true,
    ...(gate.localOnly !== undefined ? { localOnly: gate.localOnly } : {})
  });
}

/**
 * Mirrors `startDigestDaemonIfConfigured`'s config resolution
 * (`tick-daemons.ts`): the digest rides the SAME
 * `MUSE_PROACTIVE_PROVIDER` / `MUSE_PROACTIVE_DESTINATION` as the
 * proactive daemon. No resolved route → nothing to ever turn on →
 * `null` (hide the row). A resolved route → a real digest row, whose
 * `enabled` reflects the SAME `MUSE_DIGEST_ENABLED` predicate
 * (default true) `digest-tick.ts` uses — `enabled: false` still
 * returns a row so the UI can show a "꺼짐" badge instead of hiding it.
 *
 * `nextAtIso` is the next occurrence of the configured local hour
 * (today if still upcoming, else tomorrow) — the same local-hour
 * comparison `runDigestFlushIfDue` makes (`now.getHours() !==
 * digestHour`). It does NOT fold in quiet-hours suppression (which can
 * push the real fire to the following day) — this is the configured-hour
 * approximation, not a live scheduler prediction.
 */
function resolveDigestStatus(
  env: NodeJS.ProcessEnv,
  now: Date,
  route: MessagingRouteResolution
): UpcomingDigest | null {
  try {
    if (route.status !== "resolved") {
      return null;
    }
    const enabled = parseBoolean(env.MUSE_DIGEST_ENABLED, true);
    const hourRaw = env.MUSE_DIGEST_HOUR ? Number(env.MUSE_DIGEST_HOUR) : undefined;
    const hour = hourRaw !== undefined && Number.isFinite(hourRaw) ? hourRaw : DEFAULT_DIGEST_HOUR;
    return { enabled, hour, nextAtIso: nextLocalHourOccurrence(now, hour).toISOString() };
  } catch {
    return null;
  }
}

function nextLocalHourOccurrence(now: Date, hour: number): Date {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

/**
 * Reads the SAME ledger file + caps `resolveInterruptionBudgetWiring`
 * hands every UNASKED notice daemon, then counts trailing-hour /
 * trailing-day deliveries with `readInterruptionBudgetStatus` — the same
 * windowing `applyInterruptionBudget` gates a real send against, so the
 * numbers shown here match what the gate itself would decide.
 */
async function resolveBudgetStatus(env: NodeJS.ProcessEnv, now: Date): Promise<InterruptionBudgetStatus> {
  const wiring = resolveInterruptionBudgetWiring(env);
  const entries = await readInterruptionLedger(wiring.ledgerFile);
  return readInterruptionBudgetStatus(entries, { dailyCap: wiring.dailyCap, hourlyCap: wiring.hourlyCap }, now);
}

/**
 * Top 5 soonest-firing ENABLED jobs, reusing the same
 * `service.list() ?? store.list()` fallback `/api/scheduler/jobs` uses.
 * A job whose cron can't be evaluated (corrupt persisted expression)
 * still appears (so the user isn't silently missing a job they created)
 * but sorts last with a `null` next-run.
 */
async function resolveScheduledJobs(
  scheduler: SchedulerRouteScheduler | undefined,
  now: Date
): Promise<readonly UpcomingScheduledJob[]> {
  if (!scheduler) {
    return [];
  }
  const jobs = await (scheduler.service?.list() ?? scheduler.store.list());
  return jobs
    .filter((job) => job.enabled)
    .map((job) => toUpcomingScheduledJob(job, now))
    .sort(compareUpcomingScheduledJobs)
    .slice(0, MAX_UPCOMING_JOBS);
}

function toUpcomingScheduledJob(job: ScheduledJob, now: Date): UpcomingScheduledJob {
  let nextRunAtIso: string | null;
  try {
    nextRunAtIso = computeNextRunAt(job, now).toISOString();
  } catch {
    nextRunAtIso = null;
  }
  const label = job.description?.trim();
  return { id: job.id, label: label && label.length > 0 ? label : job.name, nextRunAtIso };
}

function compareUpcomingScheduledJobs(left: UpcomingScheduledJob, right: UpcomingScheduledJob): number {
  if (left.nextRunAtIso === null && right.nextRunAtIso === null) return 0;
  if (left.nextRunAtIso === null) return 1;
  if (right.nextRunAtIso === null) return -1;
  return left.nextRunAtIso.localeCompare(right.nextRunAtIso);
}

/** The single pending reminder due soonest, same store the `/api/reminders` routes read. */
async function resolveNextReminder(remindersFile: string | undefined): Promise<UpcomingReminder | null> {
  if (!remindersFile) {
    return null;
  }
  const all = await readReminders(remindersFile);
  const pending = all.filter((reminder) => reminder.status === "pending").slice().sort(compareRemindersByDueAt);
  const next = pending[0];
  return next ? { dueAtIso: next.dueAt, id: next.id, text: next.text } : null;
}
