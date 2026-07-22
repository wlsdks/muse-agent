import { createHash, randomBytes } from "node:crypto";

import {
  claimObserveLease,
  recordObserveSample,
  releaseObserveLease,
  renewObserveLease,
  type ObserveAppCategory,
  type ObserveLeaseAuthority
} from "./observe-store.js";

export interface ObserveCollectorOptions {
  readonly assertKnownThread: (threadId: string) => Promise<void>;
  readonly file: string;
  readonly intervalMs: number;
  readonly now?: () => Date;
  readonly sessionId: string;
  readonly threadId: string;
}

export interface ObserveCollector {
  claim(): Promise<void>;
  release(): Promise<void>;
  renew(): Promise<void>;
  sample(appCategory: ObserveAppCategory): Promise<void>;
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
    async claim() {
      await options.assertKnownThread(options.threadId);
      authority = await claimObserveLease(options.file, options.sessionId, fingerprint, options.intervalMs, now());
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
    async renew() {
      await options.assertKnownThread(options.threadId);
      await renewObserveLease(options.file, options.sessionId, requireAuthority(), options.intervalMs, now());
    },
    async sample(appCategory) {
      await options.assertKnownThread(options.threadId);
      const observedAt = now();
      await recordObserveSample(options.file, options.sessionId, appCategory, observedAt, { authority: requireAuthority() });
    }
  };
}
