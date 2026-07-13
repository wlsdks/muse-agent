import type { ModelResponse } from "@muse/model";

import { detectCorrections } from "./correction-distiller.js";
import type { SessionTurnLine } from "./episodic-summariser.js";
import type { AgentRunContext, HookStage } from "./types.js";

/**
 * Capture a correction the moment it happens — on EVERY surface.
 *
 * Until now, "Muse learns you" was true on exactly one surface: the interactive
 * `muse chat` TUI, and only when it exited cleanly (the end-of-session pipeline is
 * the sole caller of the distiller). One-shot `muse ask`, the web chat, Telegram
 * and every API caller learned NOTHING — they read the playbook but never wrote to
 * it. That is why a heavily-used install can still have an empty playbook: the
 * user corrected Muse dozens of times on the surfaces that do not listen.
 *
 * Correction capture belongs where every surface already meets: the runtime's
 * `afterComplete` hook, beside user-memory auto-extract. The hook only ENQUEUES
 * (append-only, cheap, no model call); the existing distiller — at session end or
 * on the daemon's tick — turns the queue into strategies. So this adds no latency
 * to the turn and no new learning semantics; it just stops throwing the signal
 * away on four surfaces out of five.
 *
 * Fail-soft, like every hook: a store error, an empty turn, or a paused learner
 * is a silent no-op. Never blocks or slows the reply.
 */
export interface CorrectionCaptureHookOptions {
  /** Appends the correction to the learn queue. Injected — agent-core owns no store. */
  readonly enqueue: (event: {
    readonly userId: string;
    readonly correction: string;
    readonly priorAnswer: string;
    readonly request?: string;
  }) => Promise<void> | void;
  /** Skip entirely when the user paused learning (`muse playbook pause`). */
  readonly isPaused?: () => Promise<boolean> | boolean;
  readonly defaultUserId?: string;
  /** Cap per turn — a single turn cannot carry more than one correction of the user's last request. */
  readonly maxPerTurn?: number;
}

function readUserId(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.["userId"];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function createCorrectionCaptureHook(options: CorrectionCaptureHookOptions): HookStage {
  const max = Math.max(1, options.maxPerTurn ?? 1);

  return {
    id: "correction-capture",
    async afterComplete(context: AgentRunContext, response: ModelResponse) {
      try {
        if (options.isPaused && (await options.isPaused())) {
          return;
        }
        const userId = readUserId(context.input.metadata) ?? options.defaultUserId;
        if (!userId) {
          return;
        }
        // The turn pair the detector needs: the user's message that CORRECTED a
        // previous answer, and the answer that preceded it. Reconstruct it from the
        // run's own message list — the same shape the session-end path reads off
        // disk, so both paths see identical exchanges.
        const turns: SessionTurnLine[] = context.input.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({ content: message.content, role: message.role as "user" | "assistant" }));
        const output = response.output ?? "";
        if (output.trim().length > 0) {
          turns.push({ content: output, role: "assistant" });
        }
        if (turns.length < 3) {
          // A correction needs something to correct: assistant answer → user
          // correction. A first turn cannot be one.
          return;
        }

        const corrections = detectCorrections(turns, { maxExchanges: max });
        for (const exchange of corrections.slice(0, max)) {
          await options.enqueue({
            correction: exchange.correction,
            priorAnswer: exchange.priorAnswer,
            userId,
            ...(exchange.request ? { request: exchange.request } : {})
          });
        }
      } catch {
        // Learning is a background nicety — it never breaks a reply.
      }
    }
  };
}
