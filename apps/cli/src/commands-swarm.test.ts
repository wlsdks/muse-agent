import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPeerRegistry, receiveAndQuarantine, sendToPeer } from "@muse/a2a";
import { addToQuarantine, listPending, readQuarantine } from "@muse/mcp";
import { AuthoredSkillStore } from "@muse/skills";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSwarmSkillDraft, renderPending } from "./commands-swarm.js";

const SHARED = "swarm-secret";
const ON = { MUSE_A2A_ENABLED: "true" } as const;

describe("renderPending", () => {
  it("shows nothing when empty, lists pending with promote/reject hints otherwise", () => {
    expect(renderPending([])).toContain("No quarantined know-how");
    const out = renderPending([
      { content: "set MTU 1380 on wg0", fromPeerId: "phone", id: "abcd1234ef", kind: "skill", receivedAtMs: Date.parse("2026-05-30T09:00:00Z"), status: "pending" }
    ]);
    expect(out).toContain("[abcd1234]");
    expect(out).toContain("from phone");
    expect(out).toContain("muse swarm promote <id>");
  });
});

describe("personal swarm — send → quarantine → promote (end to end)", () => {
  let dir: string;
  let quarantineFile: string;
  let authoredDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-swarm-"));
    quarantineFile = join(dir, "swarm-quarantine.json");
    authoredDir = join(dir, "authored");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("a skill shared by peer A lands quarantined on peer B and runs nothing until promoted", async () => {
    // Peer A (phone) shares a skill to peer B (laptop). Capture the real A2A POST.
    let posted: { body: string; sig: string } | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      posted = { body: String(init?.body), sig: String((init?.headers as Record<string, string>)["x-muse-a2a-signature"]) };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await sendToPeer({
      env: ON,
      fetchImpl,
      fromPeerId: "phone",
      outbound: { content: "# VPN fix\nSet MTU 1380 on wg0 and restart wireguard.", kind: "skill" },
      peer: { id: "laptop", secret: SHARED, url: "https://laptop.test/a2a" }
    });
    expect(posted).toBeDefined();

    // Peer B (laptop) receives it: the safety core classifies → quarantine → deposit.
    const receiverRegistry = createPeerRegistry([{ id: "phone", secret: SHARED, url: "https://phone.test/a2a" }]);
    const decision = await receiveAndQuarantine({
      deposit: (i) => addToQuarantine(quarantineFile, i).then(() => undefined),
      env: ON,
      rawBody: posted!.body,
      registry: receiverRegistry,
      signature: posted!.sig
    });
    expect(decision.disposition).toBe("quarantine");

    // It is PENDING — inert, not yet an authored skill.
    const pending = listPending(await readQuarantine(quarantineFile));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.fromPeerId).toBe("phone");
    const store = new AuthoredSkillStore({ dir: authoredDir });
    expect(await store.listAuthored()).toHaveLength(0); // nothing authored yet

    // Promote it → execute-gated authored skill.
    const res = await store.writeOrPatch(buildSwarmSkillDraft(pending[0]!));
    expect(res.action).toBeTruthy();
    const authored = await store.listAuthored();
    expect(authored).toHaveLength(1);
    expect(authored[0]!.body).toContain("MTU 1380"); // the shared know-how is now available as guidance
    // Execute-gate: a SkillDraft has no `requires`, so the promoted skill can
    // never declare runnable bins → muse.skills.run refuses to execute it.
    expect(authored[0]!.frontmatter.requires).toBeUndefined();
  });
});
