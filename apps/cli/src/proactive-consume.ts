/**
 * Pure decision for draining the proactive/completion poll into the transcript.
 * Split out of `chat-ink.ts` so the idle-gating rule is unit-testable without a
 * React render (hermes async-delegation contract: a completion event is
 * consumed only during an idle window, never inserted mid-generation).
 */

export interface DrainedProactiveTurn {
  readonly role: "proactive";
  readonly text: string;
}

export interface ProactiveDrainItem {
  readonly id: string;
  readonly text: string;
}

export interface SelectDrainedProactiveTurnsArgs {
  /** Whether the chat is idle at the moment the async poll fetch resolves —
   *  NOT at the moment the poll started. A tick can start idle and finish
   *  after the user began a new turn; re-checking here (not just at tick
   *  start) is what closes the mid-generation insertion gap. */
  readonly idleAtConsume: boolean;
  readonly grouped: string | undefined;
  readonly unseenJobs: readonly ProactiveDrainItem[];
  readonly unseenNudges: readonly ProactiveDrainItem[];
}

/**
 * The proactive/completion turns to append to the transcript on THIS drain.
 * Busy at consume time means the poll's own fetch outlived the idle window it
 * started in — drain nothing so the model's in-flight generation is never
 * interrupted by an inserted turn; the caller must leave the source items
 * unseen so they re-surface on the next idle tick instead of being lost.
 */
export function selectDrainedProactiveTurns(
  args: SelectDrainedProactiveTurnsArgs
): readonly DrainedProactiveTurn[] {
  if (!args.idleAtConsume) return [];
  return [
    ...(args.grouped ? [{ role: "proactive" as const, text: args.grouped }] : []),
    ...args.unseenJobs.map((item) => ({ role: "proactive" as const, text: item.text })),
    ...args.unseenNudges.map((item) => ({ role: "proactive" as const, text: item.text }))
  ];
}
