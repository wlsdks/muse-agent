/**
 * Swarm quarantine — where know-how received over A2A lands, INERT, until the
 * user promotes it. A received skill/strategy/council-utterance is never run and
 * never auto-applied: it sits `pending` here (execute-gated, mirroring the
 * authored-skill store) so the user can review the source peer + content and
 * `promote` it (into the authored-skill store, still execute-gated) or `reject`
 * it. This is the persistence half of the "inbound is inert" guarantee — the
 * deterministic `classifyInbound` decides quarantine|reject; this is where a
 * quarantined item waits.
 *
 *   - `~/.muse/swarm-quarantine.json` is the sidecar (FIFO-trimmed, atomic +
 *     mutation-queued write — same primitive as the trust ledger).
 *   - Tolerant reads: missing / bad-JSON / wrong-shape → empty. One corrupt row
 *     doesn't sink the file.
 */

import { promises as fs } from "node:fs";

import { withFileLock } from "@muse/shared";
import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";

/**
 * Mirrors `@muse/agent-core` `A2APayloadKind`. Duplicated (not imported) because
 * `@muse/mcp` deliberately does not depend on `@muse/agent-core`; the safety
 * core already guarantees only these kinds are ever accepted into quarantine.
 */
type A2APayloadKind = "skill" | "strategy" | "council-utterance";

export type QuarantineStatus = "pending" | "promoted" | "rejected";

export interface SwarmQuarantineEntry {
  /** Stable id for `muse swarm promote <id>`. */
  readonly id: string;
  /** Know-how kind — never an executable/tool kind (the safety core already refused those). */
  readonly kind: A2APayloadKind;
  /** The redacted know-how content (skill md / strategy text / utterance). */
  readonly content: string;
  /** Allowlisted peer it came from. */
  readonly fromPeerId: string;
  readonly receivedAtMs: number;
  readonly status: QuarantineStatus;
  readonly label?: string;
  readonly resolvedAtMs?: number;
}

const MAX_QUARANTINE_ENTRIES = 1_000;
const SHAREABLE_KINDS: ReadonlySet<string> = new Set<A2APayloadKind>(["skill", "strategy", "council-utterance"]);

function isEntry(value: unknown): value is SwarmQuarantineEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === "string"
    && typeof e.kind === "string" && SHAREABLE_KINDS.has(e.kind)
    && typeof e.content === "string"
    && typeof e.fromPeerId === "string"
    && typeof e.receivedAtMs === "number" && Number.isFinite(e.receivedAtMs)
    && (e.status === "pending" || e.status === "promoted" || e.status === "rejected");
}

export async function readQuarantine(file: string): Promise<readonly SwarmQuarantineEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { quarantine?: unknown }).quarantine)) {
    return [];
  }
  return (parsed as { quarantine: unknown[] }).quarantine.flatMap((e): readonly SwarmQuarantineEntry[] =>
    isEntry(e) ? [e] : []
  );
}

async function writeQuarantine(file: string, entries: readonly SwarmQuarantineEntry[]): Promise<void> {
  const trimmed = entries.length > MAX_QUARANTINE_ENTRIES
    ? entries.slice(entries.length - MAX_QUARANTINE_ENTRIES)
    : entries;
  await atomicWriteFile(file, `${JSON.stringify({ quarantine: trimmed }, null, 2)}\n`);
}

/** Keep the inert inbound ledger coherent across CLI, API, and daemon processes. */
async function mutateQuarantine<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return withFileMutationQueue(file, () => withFileLock(file, operation));
}

export interface AddToQuarantineInput {
  readonly id: string;
  readonly kind: A2APayloadKind;
  readonly content: string;
  readonly fromPeerId: string;
  readonly receivedAtMs: number;
  readonly label?: string;
}

/** Deposit a received know-how payload as `pending`. Serialised against concurrent receives. */
export async function addToQuarantine(file: string, input: AddToQuarantineInput): Promise<SwarmQuarantineEntry> {
  const entry: SwarmQuarantineEntry = {
    content: input.content,
    fromPeerId: input.fromPeerId,
    id: input.id,
    kind: input.kind,
    receivedAtMs: input.receivedAtMs,
    status: "pending",
    ...(input.label !== undefined ? { label: input.label } : {})
  };
  await mutateQuarantine(file, async () => {
    const existing = await readQuarantine(file);
    await writeQuarantine(file, [...existing, entry]);
  });
  return entry;
}

/** Build the execute-gated authored-skill draft for a promoted swarm skill.
 * Shared by the CLI (`muse swarm promote`) and the API promote route so the
 * two surfaces can never drift on what a promotion produces. */
export function buildSwarmSkillDraft(entry: SwarmQuarantineEntry): { readonly name: string; readonly description: string; readonly body: string } {
  return {
    body: entry.content,
    description: `Shared by ${entry.fromPeerId} via the Muse swarm (execute-gated — guidance only until you grant it tools).`,
    name: `swarm-${entry.fromPeerId}-${entry.id.slice(0, 8)}`.replace(/[^a-z0-9-]/giu, "-")
  };
}

/** Pure: the still-pending entries (most recent first). */
export function listPending(entries: readonly SwarmQuarantineEntry[]): readonly SwarmQuarantineEntry[] {
  return [...entries].filter((e) => e.status === "pending").sort((a, b) => b.receivedAtMs - a.receivedAtMs);
}

/**
 * Resolve a pending entry (promote / reject). Returns the updated entry, or null
 * when the id isn't a pending entry (already resolved / unknown).
 */
export async function setQuarantineStatus(
  file: string,
  id: string,
  status: Exclude<QuarantineStatus, "pending">,
  atMs: number
): Promise<SwarmQuarantineEntry | null> {
  return mutateQuarantine(file, async () => {
    const existing = await readQuarantine(file);
    const index = existing.findIndex((e) => e.id === id && e.status === "pending");
    if (index < 0) return null;
    const updated: SwarmQuarantineEntry = { ...existing[index]!, resolvedAtMs: atMs, status };
    await writeQuarantine(file, existing.map((e, i) => (i === index ? updated : e)));
    return updated;
  });
}
