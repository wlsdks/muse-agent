/**
 * Load the swarm peer config (`~/.muse/a2a-peers.json`) into a registry.
 *
 *   { "selfId": "my-laptop",
 *     "peers": [ { "id": "my-phone", "url": "https://…/a2a", "secret": "…" },
 *                { "id": "alice", "url": "https://…/a2a", "secretEnv": "MUSE_PEER_ALICE" } ] }
 *
 * `selfId` is who this Muse is in the swarm (the outbound `fromPeerId`); `peers`
 * is the allowlist. A peer's HMAC secret may be given inline (`secret`) OR — to
 * keep it OUT of the plaintext file — via `secretEnv`, the name of an env var
 * holding it. Tolerant: a missing / malformed file, or a peer whose secret
 * doesn't resolve, yields no peer (nothing sends, nothing is accepted).
 */

import { promises as fs } from "node:fs";

import { isRecord } from "@muse/shared";
import { createPeerRegistry, type A2APeer, type PeerRegistry } from "./peer-registry.js";

export interface PeerConfig {
  readonly selfId: string;
  readonly registry: PeerRegistry;
  readonly peers: readonly A2APeer[];
}

/** Resolve one config entry to a peer, reading `secret` inline or from `secretEnv`. */
function resolvePeer(value: unknown, env: Record<string, string | undefined>): A2APeer | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length === 0 || typeof value.url !== "string" || value.url.length === 0) return null;
  let secret: string | undefined;
  if (typeof value.secret === "string" && value.secret.length > 0) {
    secret = value.secret;
  } else if (typeof value.secretEnv === "string") {
    const fromEnv = env[value.secretEnv];
    if (typeof fromEnv === "string" && fromEnv.length > 0) secret = fromEnv;
  }
  if (secret === undefined) return null;
  return { id: value.id, secret, url: value.url, ...(typeof value.label === "string" ? { label: value.label } : {}) };
}

export async function loadPeerConfig(file: string, env: Record<string, string | undefined> = process.env): Promise<PeerConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { peers: [], registry: createPeerRegistry([]), selfId: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { peers: [], registry: createPeerRegistry([]), selfId: "" };
  }
  if (!isRecord(parsed)) {
    return { peers: [], registry: createPeerRegistry([]), selfId: "" };
  }
  const selfId = typeof parsed.selfId === "string" ? parsed.selfId : "";
  const peers = Array.isArray(parsed.peers)
    ? parsed.peers.flatMap((p): readonly A2APeer[] => { const r = resolvePeer(p, env); return r ? [r] : []; })
    : [];
  return { peers, registry: createPeerRegistry(peers), selfId };
}
