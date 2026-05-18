/**
 * Pure data layer for memory vetoes (`~/.muse/vetoes.json`).
 *
 * The "teach" half of P6's correction loop (P6-b2): when the user
 * undoes/vetoes a logged autonomous action, a durable veto for
 * that action class is recorded so the SAME trigger no longer
 * auto-acts. A veto overrides any prior consent — the user's
 * "don't do this again" wins.
 *
 * Action class = {userId, objectiveId, scope} — the same
 * granularity as a consent grant, so vetoing one objective's
 * consented action does not nuke unrelated scopes.
 *
 * Same durability posture as the other personal stores: atomic
 * fsync+rename write, tolerant read, corrupt store quarantined
 * aside (never destroyed).
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import type { JsonObject } from "@muse/shared";

export interface ActionVeto {
  readonly id: string;
  readonly userId: string;
  readonly objectiveId: string;
  readonly scope: string;
  readonly vetoedAt: string;
  readonly reason?: string;
}

async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
}

export async function readVetoes(file: string): Promise<readonly ActionVeto[]> {
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
    await quarantineCorruptStore(file);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { vetoes?: unknown }).vetoes)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { vetoes: unknown[] }).vetoes.flatMap((entry): readonly ActionVeto[] =>
    isActionVeto(entry) ? [entry] : []
  );
}

export async function writeVetoes(file: string, vetoes: readonly ActionVeto[]): Promise<void> {
  const payload = `${JSON.stringify({ vetoes }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/**
 * Record a veto. Idempotent on `id`: re-vetoing the same id
 * REPLACES (updating the reason/timestamp without duplicating).
 */
export async function recordVeto(file: string, veto: ActionVeto): Promise<void> {
  const existing = await readVetoes(file);
  const filtered = existing.filter((entry) => entry.id !== veto.id);
  await writeVetoes(file, [...filtered, veto]);
}

/**
 * Review surface: the learned avoidances the user can see —
 * "what Muse learned not to do" — newest-first, optionally scoped
 * to one user. Parallel to `queryActionLog`.
 */
export async function queryVetoes(
  file: string,
  query: { readonly userId?: string } = {}
): Promise<readonly ActionVeto[]> {
  const all = await readVetoes(file);
  const scoped = query.userId ? all.filter((v) => v.userId === query.userId) : all;
  return [...scoped].sort((a, b) => b.vetoedAt.localeCompare(a.vetoedAt));
}

/**
 * Clear one learned avoidance by id so a correction is not
 * permanent-by-accident. Returns true when an entry was removed,
 * false when the id was absent (no-op). After removal `hasVeto`
 * for that class is false again, so the avoidance directive no
 * longer injects and the consented-action gate no longer blocks.
 */
export async function removeVeto(file: string, id: string): Promise<boolean> {
  const existing = await readVetoes(file);
  const next = existing.filter((entry) => entry.id !== id);
  if (next.length === existing.length) {
    return false;
  }
  await writeVetoes(file, next);
  return true;
}

/**
 * Fail-closed-direction veto check: true when ANY veto matches the
 * user, objective AND scope. A read/parse problem degrades to
 * `false` — a veto store that cannot be read must not silently
 * unblock; the consent gate is the primary guard, the veto is an
 * additional deny layer, so "no readable veto" ⇒ defer to consent.
 */
export async function hasVeto(
  file: string,
  query: { readonly userId: string; readonly objectiveId: string; readonly scope: string }
): Promise<boolean> {
  const all = await readVetoes(file);
  return all.some(
    (v) => v.userId === query.userId && v.objectiveId === query.objectiveId && v.scope === query.scope
  );
}

export function serializeVeto(veto: ActionVeto): JsonObject {
  return {
    id: veto.id,
    objectiveId: veto.objectiveId,
    scope: veto.scope,
    userId: veto.userId,
    vetoedAt: veto.vetoedAt,
    ...(veto.reason ? { reason: veto.reason } : {})
  };
}

function isActionVeto(value: unknown): value is ActionVeto {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as ActionVeto;
  return (
    typeof v.id === "string" &&
    typeof v.userId === "string" &&
    typeof v.objectiveId === "string" &&
    typeof v.scope === "string" &&
    typeof v.vetoedAt === "string"
  );
}
