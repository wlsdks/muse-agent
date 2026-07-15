/**
 * Turn-analysis: the package-level cores of the CLI's session-end learning that
 * the SERVER / daemon (which has no session-end) also needs — commitment →
 * check-in scanning and correction → preference inference over a turn's
 * messages. Split out of context-engineering-builders.ts; each is a pure
 * orchestration over the @muse/agent-core detectors + the persistence stores.
 */

import { collapseNearDuplicateCommitments, detectCorrections, detectUserCommitments, findSupersededPreferenceId, inferPreferenceFromCorrection, selectDischargedCommitments, selectOpenCommitments, type Awaitable, type SessionTurnLine } from "@muse/agent-core";
import { appendCheckins, cancelCheckin, readCheckins, scheduleCheckins, writeCheckins, type PersistedCheckin } from "@muse/proactivity";
import type { UserModelSlot } from "@muse/memory";
import { withBestEffort } from "@muse/shared";

import { createGateEmbedder } from "./context-engineering-builders.js";

/**
 * Deterministic commitment → check-in scan over the turn's user messages — the
 * package-level core of the CLI's `scanSessionCheckins`, so the SERVER / daemon
 * (which has no session-end) also captures open-loops the user voices and
 * schedules the proactive check-in. No model: `detectUserCommitments` is a rule
 * pass and `scheduleCheckins` is deterministic (deduped, per-day capped,
 * quiet-hours applied at delivery). Returns the newly-scheduled check-ins.
 */
export async function scanCommitmentsFromTurns(
  userTurns: readonly string[],
  options: {
    readonly file: string;
    readonly userId: string;
    readonly now?: () => Date;
    /** Injected embedder for semantic near-duplicate collapse. Defaults to createGateEmbedder(process.env). */
    readonly embed?: (text: string) => Promise<readonly number[]>;
  }
): Promise<readonly PersistedCheckin[]> {
  const embedder = options.embed ?? createGateEmbedder(process.env);
  // π-Bench (arXiv:2605.14678): drop commitments the user already discharged
  // later in the conversation BEFORE near-duplicate collapse + scheduling.
  const raw = await withBestEffort(selectOpenCommitments(userTurns, embedder), detectUserCommitments(userTurns));
  let existing = await withBestEffort(readCheckins(options.file), []);
  // Cross-session auto-discharge (π-Bench arXiv:2605.14678) — parity with the CLI
  // `scanSessionCheckins`: cancel a STANDING scheduled check-in the user reports done
  // this session (the in-session filter above only sees one conversation; a persisted
  // check-in outlives it). MUST run before the no-new-commitments early-return below — a
  // discharge-only session ("done, sent it") has zero new commitments but should still
  // cancel the standing nudge. Best-effort: never block scheduling.
  try {
    const scheduledOpen = existing.filter((c) => c.status === "scheduled").map((c) => ({ commitment: c.commitment, id: c.id }));
    const dischargedIds = await selectDischargedCommitments(scheduledOpen, userTurns, embedder);
    if (dischargedIds.length > 0) {
      for (const id of dischargedIds) {
        existing = cancelCheckin(existing, id).checkins;
      }
      await writeCheckins(options.file, existing);
    }
  } catch { /* discharge is best-effort — a failure must not block scheduling */ }
  if (raw.length === 0) return [];
  const collapsed = await withBestEffort(collapseNearDuplicateCommitments(raw, embedder), raw);
  const commitments = collapsed.map((c) => c.text);
  const fresh = scheduleCheckins(commitments, {
    existing,
    now: (options.now ?? ((): Date => new Date()))(),
    userId: options.userId
  });
  await appendCheckins(options.file, fresh);
  return fresh;
}

/**
 * Infer stable preferences from corrections in the turn → upsert into the typed
 * user model (superseding by category). The package-level core of the CLI's
 * `inferSessionPreferences`, so the server/daemon learns the user's style too.
 * One local-model call per detected correction; NONE-aware (parseInferredPreference
 * rejects vacuous traits + requires a category), so it never fabricates a
 * preference. Returns `"value (category)"` for each preference learned.
 */
export async function inferPreferencesFromTurns(
  turns: readonly SessionTurnLine[],
  options: {
    readonly model: string;
    readonly modelProvider: Parameters<typeof inferPreferenceFromCorrection>[1]["modelProvider"];
    readonly store: {
      upsertUserModelSlot?: (userId: string, slot: UserModelSlot) => unknown;
      /** Optional: drop a stale belief the new preference supersedes (cross-category contradiction). */
      removeUserModelSlot?: (userId: string, id: string) => unknown;
    };
    readonly userId: string;
    readonly now?: () => Date;
    /** Embedder for the held-out support gate; omitted ⇒ no gate (back-compat). */
    readonly embed?: (text: string) => Promise<readonly number[]>;
    /**
     * Optional reader of the user's existing typed preference slots. When provided
     * (with `store.removeUserModelSlot`), a newly-inferred preference that CONTRADICTS
     * an existing DIFFERENT-category one supersedes it (belief revision, arXiv:2606.09483)
     * — the by-category upsert alone can't catch a cross-category contradiction.
     */
    readonly listExistingPreferences?: (userId: string) => Awaitable<readonly { readonly id: string; readonly value: string }[]>;
  }
): Promise<readonly string[]> {
  const upsert = options.store.upsertUserModelSlot;
  if (!upsert) return [];
  const remove = options.store.removeUserModelSlot;
  const exchanges = detectCorrections(turns);
  const added: string[] = [];
  for (const exchange of exchanges) {
    const pref = await inferPreferenceFromCorrection(exchange, {
      model: options.model,
      modelProvider: options.modelProvider,
      ...(options.embed ? { embed: options.embed } : {})
    });
    if (!pref || !pref.category) continue; // parseInferredPreference guarantees a category when it returns one
    const prefId = `pref-${pref.category}`;
    // Belief-revision supersession: a NEW preference contradicting a stored
    // DIFFERENT-category one would otherwise inject conflicting persona guidance
    // every turn — drop the stale belief (newer wins). Read BEFORE the upsert so
    // the just-written slot isn't a candidate; reuses the model-polarity primitive.
    const existing = options.listExistingPreferences && remove
      ? await options.listExistingPreferences(options.userId)
      : undefined;
    await upsert(options.userId, {
      category: pref.category,
      confidence: pref.confidence,
      id: prefId, // supersede by category — a changed mind updates, not piles up
      kind: "preference",
      updatedAt: (options.now ?? ((): Date => new Date()))(),
      value: pref.value
    });
    if (existing && remove) {
      const supersededId = await findSupersededPreferenceId(pref.value, prefId, existing, {
        model: options.model,
        modelProvider: options.modelProvider
      });
      if (supersededId) await remove(options.userId, supersededId);
    }
    added.push(`${pref.value} (${pref.category})`);
  }
  return added;
}
