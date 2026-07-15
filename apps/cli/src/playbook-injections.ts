/**
 * Per-session record of WHICH playbook strategies were injected into each
 * chat turn's prompt (`~/.muse/playbook-injections.jsonl`, one JSONL line per
 * runtime turn that injected a non-empty id set).
 *
 * Session-end reinforcement credit (`chat-distill-corrections.ts` moveReward)
 * reads this to scope its credit/decay target to strategies that were
 * ACTUALLY injected during the session — without it the target is re-derived
 * by cosine similarity, which can move the reward of a never-injected
 * bystander strategy (fabricated reward attribution). Sessions with no
 * recorded injections keep the legacy cosine path.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveHomeDir } from "@muse/shared";

import { isRecord } from "./credential-store.js";

// Rewrite-trim threshold: appends are once per chat turn, so this is reached
// rarely; when it is, the newest KEEP_LINES_ON_TRIM lines are kept (readers
// only ever need the current session's tail).
const TRIM_AT_BYTES = 256 * 1024;
const KEEP_LINES_ON_TRIM = 500;

export interface PlaybookInjectionRecord {
  /** ISO timestamp of the turn the injection happened on. */
  readonly tsIso: string;
  readonly userId: string;
  /** Store ids of the strategies injected into that turn's prompt. */
  readonly ids: readonly string[];
}

export function playbookInjectionsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MUSE_PLAYBOOK_INJECTIONS_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return path.join(resolveHomeDir(), ".muse", "playbook-injections.jsonl");
}

export async function appendPlaybookInjection(
  record: PlaybookInjectionRecord,
  filePath: string = playbookInjectionsPath()
): Promise<void> {
  const ids = record.ids.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0 || record.userId.length === 0) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify({ ids, tsIso: record.tsIso, userId: record.userId })}\n`;
  await writeFile(filePath, line, { flag: "a", mode: 0o600 });
  await trimIfOversized(filePath);
}

async function trimIfOversized(filePath: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (info.size <= TRIM_AT_BYTES) {
      return;
    }
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((entry) => entry.trim().length > 0);
    await writeFile(filePath, `${lines.slice(-KEEP_LINES_ON_TRIM).join("\n")}\n`, { mode: 0o600 });
  } catch {
    // fail-soft — a failed trim must never lose the append that preceded it
  }
}

function parseInjectionLine(line: string): PlaybookInjectionRecord | undefined {
  try {
    const parsed = JSON.parse(line);
    if (
      !isRecord(parsed)
      || typeof parsed.tsIso !== "string"
      || typeof parsed.userId !== "string"
      || !Array.isArray(parsed.ids)
    ) {
      return undefined;
    }
    const ids = parsed.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    return ids.length > 0 ? { ids, tsIso: parsed.tsIso, userId: parsed.userId } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The union of strategy ids recorded as injected for `userId` at or after
 * `sinceIso` (the session's boundary timestamp). Missing file ⇒ empty set
 * (legacy session — the caller falls back to cosine credit).
 */
export async function readSessionInjectedIds(
  args: { readonly sinceIso: string; readonly userId: string },
  filePath: string = playbookInjectionsPath()
): Promise<ReadonlySet<string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return new Set();
  }
  const since = Date.parse(args.sinceIso);
  const ids = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const record = parseInjectionLine(trimmed);
    if (!record || record.userId !== args.userId) continue;
    const at = Date.parse(record.tsIso);
    if (!Number.isFinite(at) || (Number.isFinite(since) && at < since)) continue;
    for (const id of record.ids) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Pass an agent-runtime event stream through unchanged while recording the
 * injected-id set the `done` event carries. `record` failures are the
 * caller's to absorb (pass a fail-soft recorder) — the stream itself never
 * throws for recording reasons.
 */
export async function* forwardRecordingInjections<T extends { readonly type: string }>(
  events: AsyncIterable<T>,
  record: (ids: readonly string[]) => void
): AsyncIterable<T> {
    for await (const event of events) {
      if (event.type === "done") {
        const ids = isRecord(event) ? event.playbookInjectedIds : undefined;
      if (Array.isArray(ids)) {
        const cleaned = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
        if (cleaned.length > 0) {
          record(cleaned);
        }
      }
    }
    yield event;
  }
}
