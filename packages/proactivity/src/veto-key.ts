/**
 * The kind-vs-instance split of a ledger sourceKey (`${kind}:${id}`, e.g.
 * "pattern-firing:tod:mon:9-12:journal") and the channel-veto matching it
 * powers. Two callers share this:
 *
 *   - `interruption-gate.ts`'s avoided-source check: a veto recorded at the
 *     KIND alone (no `:id`) silences every future notice from that loop, not
 *     just one instance — `isVetoed` checks both the exact key AND its kind.
 *   - the channel-veto reply handler's `vetoKeyFor`: deciding what to
 *     RECORD when a user says "stop" to the most recent delivery.
 */

export function kindOf(sourceKey: string): string {
  const i = sourceKey.indexOf(":");
  return i === -1 ? sourceKey : sourceKey.slice(0, i);
}

/** True when `sourceKey` is vetoed — an exact match, OR its kind alone was
 *  vetoed (kind-level veto). `avoidedSources` unset never vetoes anything. */
export function isVetoed(avoidedSources: ReadonlySet<string> | undefined, sourceKey: string): boolean {
  if (!avoidedSources) return false;
  return avoidedSources.has(sourceKey) || avoidedSources.has(kindOf(sourceKey));
}

/**
 * `followup` and `background-exit` notices carry a one-shot id that never
 * recurs (a fresh followup/exit gets a fresh id every time it fires), so
 * vetoing the INSTANCE key would silence nothing going forward — the veto
 * must be recorded at the KIND instead (every future followup/exit,
 * silenced). `pattern-firing`, `ambient-notice`, and `commitment-checkin`
 * (whose ledger sourceKey is the normalised, recurring commitment text, not
 * a one-shot id) DO recur on the same id, so an instance-level veto there
 * actually matches a future notice and is the more useful, narrower record
 * (only that pattern/rule/commitment, not every one from the loop).
 */
const KIND_ONLY_VETO: ReadonlySet<string> = new Set(["followup", "background-exit"]);

export function vetoKeyFor(sourceKey: string): string {
  const kind = kindOf(sourceKey);
  return KIND_ONLY_VETO.has(kind) ? kind : sourceKey;
}
