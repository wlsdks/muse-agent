/**
 * Pure data layer for the learned-strategy playbook (`~/.muse/playbook.json`).
 *
 * ACE — Agentic Context Engineering (arXiv 2510.04618): a frozen model
 * self-improves by accumulating small strategy deltas in an evolving playbook.
 * This is the positive counterpart to the veto store — a veto says "don't do
 * X", a playbook entry says "when X, prefer Y" — injected into agent runs as
 * `[Learned Strategies]` so past feedback shapes future behaviour without
 * fine-tuning. Same durability posture as the sibling stores: atomic
 * fsync+rename write, tolerant read, corrupt store quarantined aside.
 *
 * Persistence + I/O layer only. The reward bounds and the PEVI/Wilson
 * retention-utility calc (cap eviction) live in `./playbook-rewards.ts` —
 * re-exported here so the public surface (`@muse/stores`, direct imports) is
 * unchanged.
 */

import { withFileMutationQueue } from "./atomic-file-store.js";
import { decryptFileAtRest, encryptFileAtRest, isFileEncryptedAtRest, readMaybeEncrypted, withFileLock, writeMaybeEncrypted } from "./encrypted-file.js";
import { PLAYBOOK_REWARD_MAX, PLAYBOOK_REWARD_MIN, retainPlaybookEntries } from "./playbook-rewards.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export {
  clampReward,
  PLAYBOOK_REWARD_MAX,
  PLAYBOOK_REWARD_MIN,
  retainPlaybookEntries
} from "./playbook-rewards.js";

/** Newest entries kept — bounds the file + the injected context. */
export const MAX_PLAYBOOK_ENTRIES = 100;

export interface PlaybookEntry {
  readonly id: string;
  readonly userId: string;
  /** The learned strategy, e.g. "when rescheduling, default to the next business day". */
  readonly text: string;
  /** Optional task-class tag (e.g. "email", "scheduling"). */
  readonly tag?: string;
  readonly createdAt: string;
  /**
   * Net learned reward (reinforcements − decays), clamped to
   * [PLAYBOOK_REWARD_MIN, PLAYBOOK_REWARD_MAX]. Absent on entries written
   * before rewards existed → read as 0 (neutral). Mutated via
   * `adjustPlaybookReward`; consumed by agent-core's reward-weighted ranking.
   */
  readonly reward?: number;
  /**
   * PROBATION: written UNATTENDED (idle daemon distillation) ⇒ recorded +
   * visible but NEVER injected, until a real reinforce graduates it (cleared
   * when reward goes positive). Breaks the self-confirmation loop. Absent =
   * graduated.
   */
  readonly probation?: boolean;
  /**
   * PROVENANCE (the "why" `muse learned` shows): how this strategy was
   * formed. `"grounded"` = distilled from a REAL correction the user gave;
   * `"reflected"` = synthesised from a reflection (no direct correction — ranked
   * below grounded so synthetic guesses never outrank evidence); `"manual"` =
   * the user typed it via `muse playbook add`. Absent = legacy/unknown.
   */
  readonly origin?: string;
  /**
   * The originating evidence for `origin: "grounded"` — the verbatim correction
   * that taught this strategy — so `muse learned` can show WHY it exists and the
   * user can judge whether to keep it. Free text; rendered truncated.
   */
  readonly source?: string;
  /**
   * ISO timestamp of the last POSITIVE reinforcement (the recency signal for
   * disuse-decay): a trusted strategy you stop reinforcing fades back
   * toward neutral over time so one stale thumbs-up can't steer the agent
   * forever. Stamped by `adjustPlaybookReward` on a positive delta only —
   * decay never refreshes it, so continued disuse keeps fading. Absent ⇒
   * `createdAt` is the fallback recency anchor.
   */
  readonly lastReinforcedAt?: string;
  /**
   * How many times this lesson has been OBSERVED — 1 (or absent) when first
   * recorded, bumped each time the unattended distiller re-derives a
   * near-duplicate (the user raised the same point again) instead of writing a
   * paraphrase duplicate. PURE observability: a repeated correction is a
   * NEGATIVE signal, so this counter MUST NOT touch `reward` or clear
   * `probation` (graduation stays bound to a positive user act) — it only lets
   * `muse learned` honestly show "you've raised this N×". Absent ⇒ observed once.
   */
  readonly timesObserved?: number;
  /**
   * Memp (arXiv 2508.06433): per-entry outcome tallies for evidence-gated
   * lifecycle. Incremented by `adjustPlaybookReward` alongside the net reward so
   * agent-core's `planStrategyLifecycle` can distinguish "never used" from "used
   * N times with mixed results". Optional for legacy compat — absent → legacy path.
   */
  readonly reinforcements?: number;
  readonly decays?: number;
}

export async function readPlaybook(file: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly PlaybookEntry[]> {
  // A WRONG key THROWS here (fail-closed) — propagate it; an undecryptable bank is
  // NOT corrupt and must NEVER be quarantined-to-empty (that would erase the
  // learned dossier on a key mismatch). The ask path + daemon read this fail-soft
  // (a key mismatch degrades to no-strategies, never a crash); the `muse playbook`
  // / `muse learned` REVIEW surfaces let the throw surface LOUDLY so the user knows.
  const { text } = await readMaybeEncrypted(file, env);
  if (text === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    await quarantineCorruptStore(file);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { entries: unknown[] }).entries.flatMap((entry): readonly PlaybookEntry[] =>
    isPlaybookEntry(entry) ? [entry] : []
  );
}

export async function writePlaybook(file: string, entries: readonly PlaybookEntry[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const text = `${JSON.stringify({ entries }, null, 2)}\n`;
  // Peek + write under the cross-process migration lock so an ordinary RL update
  // (adjustPlaybookReward / a daemon decay) can't race `encryptPlaybookAtRest` and
  // clobber it with a stale-format payload; format is preserved. 0o600 kept.
  await withFileLock(file, async () => {
    const encrypted = await isFileEncryptedAtRest(file);
    await writeMaybeEncrypted(file, text, encrypted, env);
  });
}

export async function recordPlaybookStrategy(file: string, entry: PlaybookEntry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Serialise the read-modify-write: concurrent strategy records must not each
  // read the same snapshot and clobber one another (a lost learned strategy is a
  // self-improvement the agent forgets), and the cap below must apply to the
  // real merged set, not a stale one.
  await withFileMutationQueue(file, async () => {
    const existing = await readPlaybook(file, env);
    const next = retainPlaybookEntries([...existing.filter((e) => e.id !== entry.id), entry], MAX_PLAYBOOK_ENTRIES);
    await writePlaybook(file, next, env);
  });
}

export async function queryPlaybook(file: string, userId?: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly PlaybookEntry[]> {
  const all = await readPlaybook(file, env);
  return userId ? all.filter((e) => e.userId === userId) : all;
}

export async function removePlaybookStrategy(file: string, id: string): Promise<boolean> {
  return withFileMutationQueue(file, async () => {
    const existing = await readPlaybook(file);
    const next = existing.filter((e) => e.id !== id);
    if (next.length === existing.length) {
      return false;
    }
    await writePlaybook(file, next);
    return true;
  });
}

/**
 * Reinforce (delta > 0) or decay (delta < 0) a strategy's learned reward,
 * clamped to [PLAYBOOK_REWARD_MIN, PLAYBOOK_REWARD_MAX] — the RL update over
 * the bank: a correction-implicated strategy is decayed so it sinks out of
 * injection; a cleanly-used one is reinforced. Serialised read-modify-write
 * (no lost update), order-preserving (order is the recency proxy ranking
 * uses). Returns the new reward, or undefined when no entry matched / delta
 * was not finite.
 */
export async function adjustPlaybookReward(
  file: string,
  id: string,
  delta: number,
  nowMs: number = Date.now()
): Promise<number | undefined> {
  if (!Number.isFinite(delta)) {
    return undefined;
  }
  return withFileMutationQueue(file, async () => {
    const existing = await readPlaybook(file);
    if (!existing.some((e) => e.id === id)) {
      return undefined;
    }
    let updated = 0;
    const next = existing.map((e) => {
      if (e.id !== id) {
        return e;
      }
      updated = Math.max(PLAYBOOK_REWARD_MIN, Math.min(PLAYBOOK_REWARD_MAX, (e.reward ?? 0) + delta));
      return {
        ...e,
        reward: updated,
        // Memp (arXiv 2508.06433): increment the tally side that matches the
        // delta so planStrategyLifecycle can distinguish conflation cases.
        ...(delta > 0
          ? { reinforcements: (e.reinforcements ?? 0) + 1 }
          : { decays: (e.decays ?? 0) + 1 }),
        // Graduation: a probation strategy with net-positive reward has
        // earned evidence — clear probation so it becomes injectable.
        ...(e.probation && updated > 0 ? { probation: false } : {}),
        // Recency anchor for disuse-decay: a real (positive) reinforce
        // refreshes it; a decay/penalty must NOT, or disuse could never fade.
        ...(delta > 0 ? { lastReinforcedAt: new Date(nowMs).toISOString() } : {})
      };
    });
    await writePlaybook(file, next);
    return updated;
  });
}

/**
 * Record that an existing lesson was OBSERVED again (the unattended distiller
 * re-derived a near-duplicate — the user raised the same point). Bumps
 * `timesObserved` ONLY (absent ⇒ becomes 2: it had been observed once at
 * record-time). Deliberately does NOT touch `reward`, `probation`, or
 * `lastReinforcedAt`: a repeated correction is a NEGATIVE signal, so promoting
 * a probation guess off the back of a repeat would invert the sign and let a
 * possibly-contradicted strategy graduate autonomously — graduation stays bound
 * to a positive user act. Serialised read-modify-write; returns the new count,
 * or undefined when no entry matched.
 */
export async function bumpPlaybookObservation(file: string, id: string): Promise<number | undefined> {
  return withFileMutationQueue(file, async () => {
    const existing = await readPlaybook(file);
    if (!existing.some((e) => e.id === id)) {
      return undefined;
    }
    let updated = 0;
    const next = existing.map((e) => {
      if (e.id !== id) {
        return e;
      }
      updated = (e.timesObserved ?? 1) + 1;
      return { ...e, timesObserved: updated };
    });
    await writePlaybook(file, next);
    return updated;
  });
}

/** Disuse is judged stale past this many days without a positive reinforce. */
export const PLAYBOOK_DECAY_STALE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Disuse-decay (continuous RL over the bank): every positive-reward
 * strategy NOT reinforced within `staleAfterDays` loses `step` reward toward
 * NEUTRAL 0 (never below — disuse fades trust, it does not punish; a real
 * correction is what drives a strategy negative). So a one-off thumbs-up
 * can't steer the agent forever: stop reinforcing a strategy and it sinks out
 * of the injected `[Learned Strategies]` block on its own. Probation, neutral,
 * and already-negative entries are untouched. Serialised read-modify-write;
 * writes only when something changed. Returns the number of strategies decayed.
 */
export async function decayStalePlaybookRewards(
  file: string,
  options: { readonly nowMs: number; readonly staleAfterDays?: number; readonly step?: number }
): Promise<number> {
  const staleMs = Math.max(0, options.staleAfterDays ?? PLAYBOOK_DECAY_STALE_DAYS) * DAY_MS;
  const step = Math.max(1, Math.trunc(options.step ?? 1));
  return withFileMutationQueue(file, async () => {
    const existing = await readPlaybook(file);
    let decayed = 0;
    const next = existing.map((e) => {
      const reward = e.reward ?? 0;
      if (e.probation === true || reward <= 0) {
        return e;
      }
      const anchorMs = Date.parse(e.lastReinforcedAt ?? e.createdAt);
      if (!Number.isFinite(anchorMs) || options.nowMs - anchorMs < staleMs) {
        return e;
      }
      decayed += 1;
      return { ...e, reward: Math.max(0, reward - step) };
    });
    if (decayed > 0) {
      await writePlaybook(file, next);
    }
    return decayed;
  });
}

function isPlaybookEntry(value: unknown): value is PlaybookEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<PlaybookEntry>;
  if (typeof e.id !== "string" || e.id.length === 0) return false;
  if (typeof e.userId !== "string" || e.userId.length === 0) return false;
  if (typeof e.text !== "string" || e.text.trim().length === 0) return false;
  if (typeof e.createdAt !== "string") return false;
  if (e.tag !== undefined && typeof e.tag !== "string") return false;
  if (e.reward !== undefined && (typeof e.reward !== "number" || !Number.isFinite(e.reward))) return false;
  if (e.probation !== undefined && typeof e.probation !== "boolean") return false;
  if (e.lastReinforcedAt !== undefined && typeof e.lastReinforcedAt !== "string") return false;
  if (e.origin !== undefined && typeof e.origin !== "string") return false;
  if (e.source !== undefined && typeof e.source !== "string") return false;
  if (e.timesObserved !== undefined && (typeof e.timesObserved !== "number" || !Number.isFinite(e.timesObserved))) return false;
  if (e.reinforcements !== undefined && (typeof e.reinforcements !== "number" || !Number.isFinite(e.reinforcements))) return false;
  if (e.decays !== undefined && (typeof e.decays !== "number" || !Number.isFinite(e.decays))) return false;
  return true;
}

/**
 * Canonical empty body — seeded when encrypting an absent/empty store so the
 * encrypted format is ESTABLISHED on disk (else the first later write would peek
 * "no file", land in plaintext, and drop the encrypt intent).
 */
const EMPTY_PLAYBOOK_BODY = `${JSON.stringify({ entries: [] }, null, 2)}\n`;

/**
 * One-shot migrate the learned-strategy bank (the self-learning DOSSIER) to
 * encryption-at-rest (AES-256-GCM under the shared MUSE_MEMORY_KEY / per-host
 * fallback). The capstone of the self-learning safety: "Muse learns you in
 * the background AND the learned model of you can't leak". Snapshots a plaintext
 * backup BEFORE encrypting, runs under the cross-process lock, idempotent.
 */
export async function encryptPlaybookAtRest(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly alreadyEncrypted: boolean; readonly backupPath?: string }> {
  return encryptFileAtRest(file, env, { emptyContent: EMPTY_PLAYBOOK_BODY });
}

/** Reverse the migration — rewrite the bank as plaintext. Throws fail-closed on a wrong key. */
export async function decryptPlaybookAtRest(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly alreadyPlaintext: boolean }> {
  return decryptFileAtRest(file, env);
}

/** Format-only check (no key needed) — is the learned bank encrypted at rest? */
export async function isPlaybookEncrypted(file: string): Promise<boolean> {
  return isFileEncryptedAtRest(file);
}
