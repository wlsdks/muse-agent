import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadPeerConfig } from "./peer-config.js";

describe("loadPeerConfig", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-peers-"));
    file = join(dir, "a2a-peers.json");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("loads selfId + the allowlisted peers", async () => {
    await writeFile(file, JSON.stringify({
      peers: [{ id: "phone", secret: "s", url: "https://phone/a2a" }, { id: "server", secret: "s2", url: "https://srv/a2a" }],
      selfId: "laptop"
    }), "utf8");
    const config = await loadPeerConfig(file);
    expect(config.selfId).toBe("laptop");
    expect(config.peers.map((p) => p.id)).toEqual(["phone", "server"]);
    expect(config.registry.isAllowed("phone")).toBe(true);
    expect(config.registry.isAllowed("stranger")).toBe(false);
  });

  it("drops malformed peer entries (missing url/secret)", async () => {
    await writeFile(file, JSON.stringify({ selfId: "me", peers: [{ id: "ok", secret: "s", url: "u" }, { id: "bad" }, 42] }), "utf8");
    const config = await loadPeerConfig(file);
    expect(config.peers.map((p) => p.id)).toEqual(["ok"]);
  });

  it("resolves a peer secret from secretEnv (keeps it OUT of the plaintext file)", async () => {
    await writeFile(file, JSON.stringify({
      peers: [
        { id: "alice", secretEnv: "MUSE_PEER_ALICE", url: "https://alice/a2a" },
        { id: "noenv", secretEnv: "MUSE_PEER_MISSING", url: "https://x/a2a" } // env unset → dropped
      ],
      selfId: "me"
    }), "utf8");
    const config = await loadPeerConfig(file, { MUSE_PEER_ALICE: "alice-secret" });
    expect(config.peers.map((p) => p.id)).toEqual(["alice"]); // noenv dropped (no secret resolved)
    expect(config.peers[0]!.secret).toBe("alice-secret");
  });

  it("prefers an inline secret over secretEnv when both are present", async () => {
    await writeFile(file, JSON.stringify({ selfId: "me", peers: [{ id: "p", secret: "inline", secretEnv: "X", url: "u" }] }), "utf8");
    expect((await loadPeerConfig(file, { X: "from-env" })).peers[0]!.secret).toBe("inline");
  });

  it("missing / malformed file → empty config (nothing sends or is accepted)", async () => {
    expect(await loadPeerConfig(file)).toMatchObject({ selfId: "", peers: [] });
    await writeFile(file, "{ not json", "utf8");
    const config = await loadPeerConfig(file);
    expect(config.selfId).toBe("");
    expect(config.registry.allowedIds().size).toBe(0);
  });
});
