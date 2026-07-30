import {
  projectLoopControlReceiptHealth,
  type LoopControlReceipt
} from "@muse/agent-core";
import type { AgentLoopHealthInput } from "@muse/shared";

export interface LatestAgentLoopHealthObserver {
  observe(receipt: LoopControlReceipt): void;
  snapshot(): AgentLoopHealthInput | undefined;
}

/**
 * Keeps only the latest validated agent-loop health projection in memory.
 * Equal timestamps settle deterministically so concurrent completions cannot
 * make the observable snapshot depend on callback arrival order.
 */
export function createLatestAgentLoopHealthObserver(): LatestAgentLoopHealthObserver {
  let latest: { readonly health: AgentLoopHealthInput; readonly orderKey: string } | undefined;

  return Object.freeze({
    observe(receipt: LoopControlReceipt): void {
      const health = projectLoopControlReceiptHealth(receipt);
      if (!health) return;
      const orderKey = `${health.endedAt}\u0000${JSON.stringify(health)}`;
      if (!latest || orderKey > latest.orderKey) {
        latest = Object.freeze({ health, orderKey });
      }
    },
    snapshot(): AgentLoopHealthInput | undefined {
      return latest?.health;
    }
  });
}
