/**
 * Watch/poll tick cluster — factored out of `commands-daemon-register.ts`'s
 * `muse daemon` action so the handler stays readable. Each tick here is a
 * read-only perception or poll (ambient window / web-watch / home-watch /
 * standing objectives / calendar-conflict watch / email sync / messaging
 * poll / browsing auto-sync): opt-in via an env flag (or a runner that is
 * simply absent when unconfigured), fail-soft so a transient failure never
 * breaks the daemon, and — for the four interval-throttled polls
 * (conflict-watch / email-sync / messaging-poll / browsing-auto-sync) — the
 * same interval + last-run gate the self-learn ticks use. Behavior is
 * unchanged, only the location of the code moved.
 *
 * `TickRunState` (defined in `daemon-selflearn-ticks.ts`, re-exported here)
 * is the `{ current }` holder that carries each tick's own last-run
 * timestamp across calls, mirroring the scheduler-handle pattern in
 * `packages/autoconfigure/src/runtime-assembly.ts`.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { parseBoolean, type MessagingPollDispatchers } from "@muse/autoconfigure";
import { isLocalOnlyEnabled } from "@muse/model";
import { GmailEmailProvider, selectUpcomingConflicts, type EmailProvider } from "@muse/domain-tools";
import type { MessagingProviderRegistry } from "@muse/messaging";
import { runDueObjectives, type AmbientNoticeRunner, type EvidenceRecord, type ObjectiveEvaluation, type WebWatchRunner } from "@muse/proactivity";
import { BROWSING_SYNC_LIMIT, locateChromeHistoryFile, shouldAutoSyncBrowsing, syncBrowsingHistory } from "@muse/recall";
import type { StandingObjective } from "@muse/stores";

import { defaultEmbedModel } from "./council-corpus.js";
import { syncEmailsToNotes } from "./email-sync.js";
import { embed } from "./embed.js";

import type { TickRunState } from "./daemon-selflearn-ticks.js";

export interface MakeAmbientTickDeps {
  readonly ambientRunner: AmbientNoticeRunner | undefined;
  readonly stdout: (message: string) => void;
}

export function makeAmbientTick(deps: MakeAmbientTickDeps): () => Promise<void> {
  const { ambientRunner, stdout } = deps;
  return async (): Promise<void> => {
    if (!ambientRunner) {
      stdout(`[${new Date().toISOString()}] ambient: skipped (no rules)\n`);
      return;
    }
    const summary = await ambientRunner.tick();
    stdout(`[${new Date().toISOString()}] ambient: delivered ${summary.delivered.toString()}\n`);
  };
}

export interface MakeWebWatchTickDeps {
  readonly webWatchRunner: WebWatchRunner | undefined;
  readonly stdout: (message: string) => void;
}

export function makeWebWatchTick(deps: MakeWebWatchTickDeps): () => Promise<void> {
  const { webWatchRunner, stdout } = deps;
  return async (): Promise<void> => {
    if (!webWatchRunner) {
      stdout(`[${new Date().toISOString()}] web-watch: skipped (no config)\n`);
      return;
    }
    const summary = await webWatchRunner.tick();
    stdout(`[${new Date().toISOString()}] web-watch: delivered ${summary.delivered.toString()}\n`);
  };
}

export interface MakeHomeWatchTickDeps {
  readonly homeWatchRunner: WebWatchRunner | undefined;
  readonly stdout: (message: string) => void;
}

export function makeHomeWatchTick(deps: MakeHomeWatchTickDeps): () => Promise<void> {
  const { homeWatchRunner, stdout } = deps;
  return async (): Promise<void> => {
    if (!homeWatchRunner) {
      stdout(`[${new Date().toISOString()}] home-watch: skipped (no config)\n`);
      return;
    }
    const summary = await homeWatchRunner.tick();
    stdout(`[${new Date().toISOString()}] home-watch: delivered ${summary.delivered.toString()}\n`);
  };
}

export interface ObjectiveActuator {
  readonly act: (objective: StandingObjective, evidence?: readonly EvidenceRecord[]) => Promise<void>;
  readonly escalate: (objective: StandingObjective, reason: string) => Promise<void>;
}

export interface MakeObjectivesTickDeps {
  readonly evaluate: ((objective: StandingObjective) => Promise<ObjectiveEvaluation>) | undefined;
  readonly actuator: ObjectiveActuator | undefined;
  readonly file: string;
  readonly stdout: (message: string) => void;
}

export function makeObjectivesTick(deps: MakeObjectivesTickDeps): () => Promise<void> {
  const { evaluate, actuator, file, stdout } = deps;
  return async (): Promise<void> => {
    if (!evaluate || !actuator) {
      stdout(`[${new Date().toISOString()}] objectives: skipped (no model resolved)\n`);
      return;
    }
    const summary = await runDueObjectives({
      act: actuator.act,
      escalate: actuator.escalate,
      evaluate,
      file
    });
    const tag = `[${new Date().toISOString()}]`;
    stdout(`${tag} objectives: ${summary.fired.length.toString()} fired, ${summary.escalated.length.toString()} escalated of ${summary.due.toString()} due`);
    if (summary.errors.length > 0) {
      stdout(`, ${summary.errors.length.toString()} error(s)`);
      for (const error of summary.errors) {
        stdout(`\n  ! ${error}`);
      }
    }
    stdout("\n");
  };
}

export interface MakeConflictWatchTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly lister: ((range: { readonly from: Date; readonly to: Date }) => Promise<readonly { readonly title: string; readonly startsAt: Date; readonly endsAt: Date; readonly allDay?: boolean }[]>) | undefined;
  readonly sidecarFile: string;
  readonly withinDays: number;
  readonly intervalMs: number;
  readonly lastRunMs: TickRunState;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly provider: string;
  readonly destination: string;
  readonly stdout: (message: string) => void;
}

/**
 * Proactive double-booking watch — scan the upcoming calendar window for
 * overlapping events and warn ONCE per clash (a Friday conflict caught on
 * Wednesday). Off by default; throttled; a key-dedup sidecar means a
 * standing clash never re-spams. Fail-soft.
 */
export function makeConflictWatchTick(deps: MakeConflictWatchTickDeps): () => Promise<void> {
  const { env: e, lister, sidecarFile, withinDays, intervalMs, lastRunMs, messagingRegistry, provider, destination, stdout } = deps;
  return async (): Promise<void> => {
    if (!parseBoolean(e.MUSE_CONFLICT_WATCH_ENABLED, false)) return;
    if (!lister) return;
    const nowMs = Date.now();
    if (lastRunMs.current !== undefined && nowMs - lastRunMs.current < intervalMs) return;
    lastRunMs.current = nowMs;
    const now = new Date(nowMs);
    try {
      const events = await lister({ from: now, to: new Date(nowMs + withinDays * 86_400_000) });
      const notices = selectUpcomingConflicts(
        events.map((ev) => ({ allDay: ev.allDay, title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt })),
        { now, withinDays }
      );
      if (notices.length === 0) return;
      let firedKeys: string[] = [];
      try {
        const parsed = JSON.parse(readFileSync(sidecarFile, "utf8")) as { keys?: unknown };
        if (Array.isArray(parsed.keys)) firedKeys = parsed.keys.filter((k): k is string => typeof k === "string");
      } catch { /* no sidecar yet ⇒ nothing fired */ }
      const fresh = notices.filter((n) => !firedKeys.includes(n.key));
      if (fresh.length === 0) return;
      const text = `Heads up — upcoming calendar conflict${fresh.length === 1 ? "" : "s"}:\n${fresh.map((n) => `• ${n.line}`).join("\n")}`;
      await messagingRegistry.send(provider, { destination, text });
      try {
        mkdirSync(dirname(sidecarFile), { recursive: true });
        writeFileSync(sidecarFile, JSON.stringify({ keys: [...firedKeys, ...fresh.map((n) => n.key)].slice(-200) }), "utf8");
      } catch { /* fail-soft — dedup persistence is best-effort */ }
      stdout(`[${now.toISOString()}] conflict-watch: warned of ${fresh.length.toString()} upcoming double-booking${fresh.length === 1 ? "" : "s"}\n`);
    } catch { /* fail-soft — a calendar hiccup must never break the daemon */ }
  };
}

export interface MakeEmailSyncTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly notesDir: string;
  readonly limit: number;
  readonly intervalMs: number;
  readonly lastRunMs: TickRunState;
  readonly stdout: (message: string) => void;
  /** Test seam — inject the email source instead of the real Gmail provider. */
  readonly emailSyncProvider?: Pick<EmailProvider, "listRecent">;
}

/**
 * Continuous email ingestion — the always-on half of `muse email sync`: pull
 * recent emails into recallable notes on its own tick, opt-in
 * (MUSE_EMAIL_SYNC_ENABLED + MUSE_GMAIL_TOKEN), interval-throttled, fail-soft.
 */
export function makeEmailSyncTick(deps: MakeEmailSyncTickDeps): () => Promise<void> {
  const { env: e, notesDir, limit, intervalMs, lastRunMs, stdout, emailSyncProvider } = deps;
  return async (): Promise<void> => {
    // Defense in depth: daemon registration normally omits this entire
    // callback under local-only, and a direct lower-level call must not read
    // Gmail token/provider either.
    if (isLocalOnlyEnabled(process.env) || isLocalOnlyEnabled(e)) return;
    if (!parseBoolean(e.MUSE_EMAIL_SYNC_ENABLED, false)) return;
    const token = e.MUSE_GMAIL_TOKEN?.trim();
    const provider = emailSyncProvider ?? (token ? new GmailEmailProvider(token) : undefined);
    if (!provider) return; // opt-in: no token, no sync
    const nowMs = Date.now();
    if (lastRunMs.current !== undefined && nowMs - lastRunMs.current < intervalMs) return;
    lastRunMs.current = nowMs;
    try {
      const written = await syncEmailsToNotes(provider, notesDir, limit);
      if (written > 0) stdout(`[${new Date(nowMs).toISOString()}] email-sync: ${written.toString()} email(s) → recall (ask about them with \`muse ask\`)\n`);
    } catch { /* fail-soft — a Gmail blip must never break the daemon */ }
  };
}

export interface MakeMessagingPollTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly poll: MessagingPollDispatchers["pollAll"];
  readonly intervalMs: number;
  readonly lastRunMs: TickRunState;
  readonly stdout: (message: string) => void;
}

/**
 * Continuous messaging ingestion — pull new inbound (Telegram / Discord /
 * Slack) into the inbox on a throttle so `muse ask` can recall it without a
 * manual `muse messaging poll`. Off by default; fail-soft.
 */
export function makeMessagingPollTick(deps: MakeMessagingPollTickDeps): () => Promise<void> {
  const { env: e, poll, intervalMs, lastRunMs, stdout } = deps;
  return async (): Promise<void> => {
    if (!parseBoolean(e.MUSE_MESSAGING_POLL_ENABLED, false)) return;
    const nowMs = Date.now();
    if (lastRunMs.current !== undefined && nowMs - lastRunMs.current < intervalMs) return;
    lastRunMs.current = nowMs;
    try {
      const result = await poll();
      const total = Object.values(result.ingestedByProvider).reduce((sum, n) => sum + n, 0);
      if (total > 0) stdout(`[${new Date(nowMs).toISOString()}] messaging-poll: +${total.toString()} new message${total === 1 ? "" : "s"} ingested (recallable via \`muse ask\`)\n`);
    } catch { /* fail-soft — a transient poll failure must never break the daemon */ }
  };
}

export interface MakeBrowsingAutoSyncTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly intervalMs: number;
  readonly lastRunMs: TickRunState;
  readonly stdout: (message: string) => void;
  /** Test seam — inject the sync so a smoke can assert the consent gate without touching a real Chrome file. */
  readonly browsingSync?: (args: { readonly env: NodeJS.ProcessEnv; readonly storeFile: string; readonly limit: number }) => Promise<{ readonly synced: number; readonly total: number }>;
}

async function defaultBrowsingSync(args: { readonly env: NodeJS.ProcessEnv; readonly storeFile: string; readonly limit: number }): Promise<{ synced: number; total: number }> {
  const historyFile = await locateChromeHistoryFile({ env: args.env });
  if (!historyFile) return { synced: 0, total: 0 };
  // Embed titles at ingest so cross-lingual recall works later. Localhost-only
  // + per-visit fail-soft: a down embedder never breaks the tick (visits still
  // ingest, unembedded, and backfill on a later tick once Ollama is back).
  return syncBrowsingHistory({
    embed: (text) => embed(text, defaultEmbedModel(args.env)),
    historyFile,
    limit: args.limit,
    storeFile: args.storeFile
  });
}

/**
 * Opt-in browsing auto-sync — the always-on half of `muse browsing sync`:
 * reads NEW Chrome visits into the local archive on its own tick. CONSENT:
 * off by default — the gate is checked FIRST, before any locate/read, so an
 * absent/false/garbage MUSE_BROWSING_AUTO_SYNC performs ZERO Chrome-file
 * access. Interval-throttled; read-only + written locally; fail-soft.
 */
export function makeBrowsingAutoSyncTick(deps: MakeBrowsingAutoSyncTickDeps): () => Promise<void> {
  const { env: e, intervalMs, lastRunMs, stdout, browsingSync } = deps;
  return async (): Promise<void> => {
    if (!parseBoolean(e.MUSE_BROWSING_AUTO_SYNC, false)) return; // consent gate FIRST — no Chrome access when off
    const nowMs = Date.now();
    if (!shouldAutoSyncBrowsing(lastRunMs.current, nowMs, intervalMs)) return;
    lastRunMs.current = nowMs;
    try {
      const storeFile = e.MUSE_BROWSING_FILE?.trim()?.length
        ? e.MUSE_BROWSING_FILE.trim()
        : join(homedir(), ".muse", "browsing.json");
      const { synced } = await (browsingSync ?? defaultBrowsingSync)({ env: e, limit: BROWSING_SYNC_LIMIT, storeFile });
      if (synced > 0) stdout(`[${new Date(nowMs).toISOString()}] browsing: synced ${synced.toString()} new visit${synced === 1 ? "" : "s"} (ask about them with \`muse ask\`)\n`);
    } catch { /* fail-soft — a Chrome-file hiccup must never break the daemon */ }
  };
}
