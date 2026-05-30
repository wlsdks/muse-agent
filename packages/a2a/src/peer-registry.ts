/**
 * The A2A peer allowlist. Only peers in this registry may send to (or receive
 * from) this Muse — an unknown sender is rejected by the transport. Each peer
 * carries a shared `secret` used to sign/verify envelopes (HMAC), so a forged
 * "from" id without the secret can't pass.
 */

export interface A2APeer {
  /** Stable peer id (e.g. "my-laptop", "alice"). */
  readonly id: string;
  /** Where to POST outbound envelopes for this peer. */
  readonly url: string;
  /** Shared secret for HMAC signing/verification. Never sent on the wire. */
  readonly secret: string;
  /** Optional human label. */
  readonly label?: string;
}

export interface PeerRegistry {
  isAllowed(id: string): boolean;
  get(id: string): A2APeer | undefined;
  allowedIds(): ReadonlySet<string>;
  list(): readonly A2APeer[];
}

export function createPeerRegistry(peers: readonly A2APeer[]): PeerRegistry {
  const byId = new Map<string, A2APeer>();
  for (const peer of peers) {
    if (peer.id.trim().length > 0 && peer.secret.length > 0) {
      byId.set(peer.id, peer);
    }
  }
  const ids: ReadonlySet<string> = new Set(byId.keys());
  return {
    allowedIds: () => ids,
    get: (id) => byId.get(id),
    isAllowed: (id) => byId.has(id),
    list: () => [...byId.values()]
  };
}
