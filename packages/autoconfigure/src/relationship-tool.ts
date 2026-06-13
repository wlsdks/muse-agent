/**
 * `overdue_contacts` agent tool + the `interactionsFromEvents` helper behind it.
 *
 * Dunbar tie-strength decay surfaces the people you've drifted from: once the
 * gap since you last spoke runs well past your USUAL cadence with someone, the
 * tie is slipping (relationship-decay.ts in @muse/agent-core does the maths from
 * TIMESTAMPS only — never message content). The CLI shipped this as
 * `muse contacts overdue`; this exposes the SAME capability to a conversation so
 * "who haven't I talked to in a while?" can be answered and acted on. Read-only,
 * draft-first — it only surfaces a gentle nudge, never sends anything.
 *
 * `interactionsFromEvents` lives here (not in apps/cli) so BOTH the CLI command
 * and the agent tool's wiring share one implementation; the runtime can only
 * project a tool from a package the assembly imports.
 */

import { overdueContacts, type ContactInteractions } from "@muse/agent-core";
import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

/** Minimal event shape interactionsFromEvents reads — `startsAt` is an ISO string (it is Date.parse'd). */
export interface EventMentionLike {
  readonly title?: string;
  readonly notes?: string;
  readonly startsAt?: string;
}

/**
 * Derive each contact's interaction timestamps from calendar events that MENTION
 * their name (or an alias) — the most reliable "we met / talked" signal without
 * reading message content. A name/alias under 2 chars is skipped (too ambiguous).
 * Pure + testable.
 */
export function interactionsFromEvents(
  contacts: readonly { readonly name: string; readonly aliases?: readonly string[] }[],
  events: readonly EventMentionLike[]
): ContactInteractions[] {
  const haystacks = events
    .map((event) => ({ ms: Date.parse(event.startsAt ?? ""), text: `${event.title ?? ""} ${event.notes ?? ""}`.toLowerCase() }))
    .filter((event) => Number.isFinite(event.ms));
  return contacts.map((contact) => {
    const needles = [contact.name, ...(contact.aliases ?? [])]
      .map((alias) => alias.trim().toLowerCase())
      .filter((alias) => alias.length >= 2);
    return {
      name: contact.name,
      timestampsMs: haystacks.filter((event) => needles.some((needle) => event.text.includes(needle))).map((event) => event.ms)
    };
  });
}

export interface OverdueContactsToolDeps {
  readonly interactions: () => Promise<readonly ContactInteractions[]> | readonly ContactInteractions[];
  /** Injected clock so the overdue window is deterministic in tests. */
  readonly now?: () => Date;
}

export function createOverdueContactsTool(deps: OverdueContactsToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Answers 'who haven't I talked to in a while?' / 'who am I losing touch with?' / 'who should I reach out to?' / '누구한테 연락이 뜸했지?'. Lists the people the user has DRIFTED OUT OF TOUCH with — those not contacted in longer than their own usual cadence (a relationship-maintenance nudge computed from calendar timestamps, never message content), most-overdue first. This is a LIST of neglected relationships, NOT a lookup of a named person — do NOT use to find one specific person's details or identity (use find_contact for 'who is <name/number>?'). Read-only and draft-first: it only SURFACES who's overdue, it never messages anyone.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: { description: "Max people to return, e.g. 5. Defaults to 10.", maximum: 50, minimum: 1, type: "integer" }
        },
        required: [],
        type: "object"
      },
      keywords: ["overdue", "reconnect", "reach out", "lost touch", "haven't talked", "out of touch", "연락", "뜸", "관계", "챙기"],
      name: "overdue_contacts",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const nowMs = (deps.now ? deps.now() : new Date()).getTime();
      const rawLimit = args["limit"];
      const maxResults = typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(50, Math.trunc(rawLimit)) : undefined;
      const interactions = await Promise.resolve(deps.interactions());
      const overdue = overdueContacts(interactions, { nowMs, ...(maxResults ? { maxResults } : {}) });
      return {
        count: overdue.length,
        overdue: overdue.map((o) => ({
          cadenceDays: Math.round(o.cadenceDays),
          gapDays: Math.round(o.gapDays),
          name: o.name,
          overdueRatio: Math.round(o.overdueRatio * 10) / 10
        }))
      };
    }
  };
}
