import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadPeerConfig } from "../src/peer-config.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-peer-config-"));
  file = join(dir, "a2a-peers.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const write = (value: unknown) => writeFile(file, JSON.stringify(value), "utf8");

describe("loadPeerConfig — tolerant load of the swarm allowlist", () => {
  it("returns an empty config for a missing file (nothing sends, nothing is accepted)", async () => {
    const cfg = await loadPeerConfig(join(dir, "does-not-exist.json"));
    expect(cfg).toMatchObject({ peers: [], selfId: "" });
    expect(cfg.registry.allowedIds().size).toBe(0);
  });

  it("returns an empty config for malformed JSON or a non-object root", async () => {
    await writeFile(file, "{ not json", "utf8");
    expect((await loadPeerConfig(file)).peers).toEqual([]);
    await writeFile(file, JSON.stringify([1, 2, 3]), "utf8"); // array, not object
    expect((await loadPeerConfig(file)).selfId).toBe("");
  });

  it("loads selfId + an inline-secret peer into the registry allowlist", async () => {
    await write({ peers: [{ id: "phone", secret: "s3kr3t", url: "https://phone/a2a" }], selfId: "laptop" });
    const cfg = await loadPeerConfig(file);
    expect(cfg.selfId).toBe("laptop");
    expect(cfg.peers).toEqual([{ id: "phone", secret: "s3kr3t", url: "https://phone/a2a" }]);
    expect(cfg.registry.get("phone")?.secret).toBe("s3kr3t");
    expect(cfg.registry.allowedIds().has("phone")).toBe(true);
  });

  it("resolves a peer's secret from secretEnv so it stays OUT of the plaintext file", async () => {
    await write({ peers: [{ id: "alice", secretEnv: "MUSE_PEER_ALICE", url: "https://alice/a2a" }], selfId: "me" });
    const cfg = await loadPeerConfig(file, { MUSE_PEER_ALICE: "from-env-secret" });
    expect(cfg.registry.get("alice")?.secret).toBe("from-env-secret");
  });

  it("DROPS a peer whose secret doesn't resolve (no inline, env var absent or empty) — never a secret-less peer", async () => {
    await write({
      peers: [
        { id: "no-secret", url: "https://x/a2a" },
        { id: "absent-env", secretEnv: "MISSING_VAR", url: "https://y/a2a" },
        // secretEnv RESOLVES but to a blank string — a present-but-empty HMAC secret
        // is trivially forgeable, so it must be dropped (exercises the length > 0 guard,
        // distinct from an UNSET env which short-circuits earlier).
        { id: "blank-env", secretEnv: "BLANK_VAR", url: "https://w/a2a" },
        { id: "good", secret: "ok", url: "https://z/a2a" }
      ],
      selfId: "me"
    });
    const cfg = await loadPeerConfig(file, { BLANK_VAR: "" });
    expect(cfg.peers.map((p) => p.id)).toEqual(["good"]); // every unresolved/blank-secret peer is excluded
  });

  it("DROPS a malformed peer entry (missing id or url) without failing the whole load", async () => {
    await write({ peers: [{ secret: "s", url: "https://x" }, { id: "", secret: "s", url: "https://y" }, { id: "ok", secret: "s", url: "https://z" }], selfId: "me" });
    expect((await loadPeerConfig(file)).peers.map((p) => p.id)).toEqual(["ok"]);
  });

  it("prefers an inline secret over secretEnv and carries an optional label", async () => {
    await write({ peers: [{ id: "p", label: "My Phone", secret: "inline", secretEnv: "SHOULD_BE_IGNORED", url: "https://p" }], selfId: "me" });
    const cfg = await loadPeerConfig(file, { SHOULD_BE_IGNORED: "env-value" });
    expect(cfg.peers[0]).toEqual({ id: "p", label: "My Phone", secret: "inline", url: "https://p" });
  });
});
