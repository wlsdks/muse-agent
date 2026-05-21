import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/**
 * Per-channel conversation memory for the inbound reply loop, so a
 * channel chat is a continuous session (the user's 2nd message
 * sees the 1st turn). Keyed by `${providerId}:${source}` — each
 * chat / DM is its own thread; threads never bleed into each other.
 *
 * Bounded to the most recent `MAX_TURNS` messages per thread (the
 * agent context budget trims anyway; unbounded growth would be a
 * slow leak). Atomic tmp+rename, 0o600, like the sibling stores.
 */

export interface ThreadTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

const MAX_TURNS = 12;

interface PersistedShape {
  readonly version: 1;
  readonly threads: Readonly<Record<string, readonly ThreadTurn[]>>;
}

function isTurn(value: unknown): value is ThreadTurn {
  if (!value || typeof value !== "object") {
    return false;
  }
  const turn = value as ThreadTurn;
  return (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string";
}

async function readAll(file: string): Promise<Record<string, ThreadTurn[]>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; threads?: unknown };
    if (parsed && parsed.version === 1 && parsed.threads && typeof parsed.threads === "object") {
      const out: Record<string, ThreadTurn[]> = {};
      for (const [key, value] of Object.entries(parsed.threads as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          out[key] = value.filter(isTurn);
        }
      }
      return out;
    }
  } catch {
    // malformed → treat as no history (the chat just starts fresh)
  }
  return {};
}

export async function readThread(file: string, key: string): Promise<readonly ThreadTurn[]> {
  return (await readAll(file))[key] ?? [];
}

const writeQueues = new Map<string, Promise<unknown>>();

export async function appendThreadTurns(
  file: string,
  key: string,
  turns: readonly ThreadTurn[]
): Promise<void> {
  if (turns.length === 0) {
    return;
  }
  const prior = writeQueues.get(file) ?? Promise.resolve();
  const next = prior.then(
    () => doAppendThreadTurns(file, key, turns),
    () => doAppendThreadTurns(file, key, turns)
  );
  writeQueues.set(file, next.catch(() => undefined));
  return next;
}

async function doAppendThreadTurns(
  file: string,
  key: string,
  turns: readonly ThreadTurn[]
): Promise<void> {
  const all = await readAll(file);
  const merged = [...(all[key] ?? []), ...turns];
  all[key] = merged.slice(Math.max(0, merged.length - MAX_TURNS));
  const payload: PersistedShape = { threads: all, version: 1 };
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}
