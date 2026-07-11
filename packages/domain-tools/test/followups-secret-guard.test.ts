import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFollowupsMcpServer } from "../src/index.js";
import { readFollowups, writeFollowups, type PersistedFollowup } from "@muse/stores";

describe("muse.followup.cancel — fail-close secret-persistence guard", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-followups-secret-guard-"));
    file = join(dir, "followups.json");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function seed(): Promise<PersistedFollowup> {
    const followup: PersistedFollowup = {
      createdAt: new Date().toISOString(),
      id: "f1",
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      status: "scheduled",
      summary: "check in on the budget",
      userId: "default"
    };
    await writeFollowups(file, [followup]);
    return followup;
  }

  const cancelTool = () => createFollowupsMcpServer({ file }).tools.find((t) => t.name === "cancel")!;

  it("refuses a password-bearing reason and performs NO write", async () => {
    await seed();
    const out = await cancelTool().execute({ id: "f1", reason: "비밀번호는 hunter2" }) as {
      blocked?: boolean;
      error?: string;
      kinds?: readonly string[];
    };
    expect(out.blocked).toBe(true);
    expect(out.error).toContain("암호화");
    expect(out.kinds).toContain("credential-label");
    const after = await readFollowups(file);
    expect(after[0]!.status).toBe("scheduled");
  });

  it("an ordinary cancel reason still works (control — 'never mind, plans changed')", async () => {
    await seed();
    const out = await cancelTool().execute({ id: "f1", reason: "never mind, plans changed" }) as {
      followup?: { status: string };
    };
    expect(out.followup?.status).toBe("cancelled");
  });

  it("a cancel with no reason still works (default 'agent-cancelled')", async () => {
    await seed();
    const out = await cancelTool().execute({ id: "f1" }) as { followup?: { status: string } };
    expect(out.followup?.status).toBe("cancelled");
  });
});
