import { createHash, randomBytes } from "node:crypto";

import {
  releaseObserveLease,
  type ObserveAppCategory,
  type ObserveLeaseAuthority
} from "./observe-store.js";
import { claimObserveLeaseSafe, recordObserveSampleSafe, renewObserveLeaseSafe } from "./observe-continuity-coordinator.js";

export interface ObserveCollectorOptions {
  readonly attunementFile: string;
  readonly file: string;
  readonly intervalMs: number;
  readonly now?: () => Date;
  readonly sessionId: string;
  readonly threadId: string;
}

export interface ObserveCollector {
  claim(at?: string): Promise<void>;
  release(): Promise<void>;
  renew(at?: string): Promise<void>;
  sample(appCategory: ObserveAppCategory, at?: string): Promise<void>;
}

/**
 * Creates a host-only collection handle. Its random owner secret and fencing
 * token remain closure-local and cannot be serialized through public status.
 */
export function createObserveCollector(options: ObserveCollectorOptions): ObserveCollector {
  const fingerprint = createHash("sha256").update(randomBytes(32)).digest("hex");
  let authority: ObserveLeaseAuthority | undefined;
  const now = (): string => (options.now ?? (() => new Date()))().toISOString();
  const requireAuthority = (): ObserveLeaseAuthority => {
    if (authority === undefined) throw new Error("Observe collector must claim before use");
    return authority;
  };
  return {
    async claim(at) {
      authority = await claimObserveLeaseSafe({ attunementFile: options.attunementFile, observeFile: options.file }, {
        collectorFingerprint: fingerprint,
        intervalMs: options.intervalMs,
        now: at ?? now(),
        sessionId: options.sessionId,
        threadId: options.threadId
      });
    },
    async release() {
      if (authority === undefined) return;
      const claimed = authority;
      try {
        await releaseObserveLease(options.file, options.sessionId, claimed);
      } finally {
        authority = undefined;
      }
    },
    async renew(at) {
      await renewObserveLeaseSafe({ attunementFile: options.attunementFile, observeFile: options.file }, {
        authority: requireAuthority(),
        intervalMs: options.intervalMs,
        now: at ?? now(),
        sessionId: options.sessionId,
        threadId: options.threadId
      });
    },
    async sample(appCategory, at) {
      await recordObserveSampleSafe({ attunementFile: options.attunementFile, observeFile: options.file }, {
        appCategory,
        authority: requireAuthority(),
        observedAt: at ?? now(),
        sessionId: options.sessionId,
        threadId: options.threadId
      });
    }
  };
}
