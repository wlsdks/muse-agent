import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { activateQualificationLearningHold } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { createQualificationLearningActiveSkillWriteGate } from "./qualification-learning-active-skill-write-gate.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "muse-active-skill-gate-"));
  const file = join(root, "qualification-learning-hold.json");
  const env = {
    HOME: root,
    MUSE_QUALIFICATION_LEARNING_HOLD_FILE: file
  };
  return {
    env,
    file,
    gate: createQualificationLearningActiveSkillWriteGate(env)
  };
}

describe("qualification learning active-skill write gate", () => {
  it("allows a mutation only while the hold is absent", async () => {
    const { gate } = await fixture();
    let mutations = 0;
    await expect(gate.run(async () => {
      mutations += 1;
      return "applied";
    })).resolves.toBe("applied");
    expect(mutations).toBe(1);
  });

  it("fails closed for active and invalid hold state without invoking the mutation", async () => {
    const active = await fixture();
    await activateQualificationLearningHold(active.file, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1"
    });
    let activeMutations = 0;
    await expect(active.gate.run(async () => {
      activeMutations += 1;
    })).rejects.toMatchObject({
      code: "MUSE_ACTIVE_SKILL_WRITE_BLOCKED",
      reason: "qualification-hold-active"
    });
    expect(activeMutations).toBe(0);

    const invalid = await fixture();
    await writeFile(invalid.file, "{malformed", { mode: 0o600 });
    let invalidMutations = 0;
    await expect(invalid.gate.run(async () => {
      invalidMutations += 1;
    })).rejects.toMatchObject({
      code: "MUSE_ACTIVE_SKILL_WRITE_BLOCKED",
      reason: "qualification-hold-invalid"
    });
    expect(invalidMutations).toBe(0);
  });

  it("shares the activation lock so no active write can land after the hold engages", async () => {
    const { file, gate } = await fixture();
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const order: string[] = [];
    const mutation = gate.run(async () => {
      order.push("mutation-entered");
      enteredResolve?.();
      await release;
      order.push("mutation-completed");
    });
    await entered;
    const activation = activateQualificationLearningHold(file, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1"
    }).then(() => {
      order.push("hold-activated");
    });
    await Promise.resolve();
    expect(order).toEqual(["mutation-entered"]);
    releaseResolve?.();
    await Promise.all([mutation, activation]);
    expect(order).toEqual([
      "mutation-entered",
      "mutation-completed",
      "hold-activated"
    ]);

    await expect(gate.run(async () => {
      order.push("forbidden");
    })).rejects.toMatchObject({ reason: "qualification-hold-active" });
    expect(order).not.toContain("forbidden");
  });

  it("does not let a sibling process steal an aged live mutation lock before activation", async () => {
    const { file, gate } = await fixture();
    const activeFile = join(file, "..", "active-skill.md");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    let child: ReturnType<typeof spawn> | undefined;

    const mutation = gate.run(async () => {
      entered.resolve();
      await release.promise;
      await writeFile(activeFile, "mutation-completed", { mode: 0o600 });
      order.push("mutation-completed");
    });

    try {
      await entered.promise;
      const stale = new Date(Date.now() - 31_000);
      await utimes(`${file}.lock`, stale, stale);

      const storeModule = pathToFileURL(
        join(import.meta.dirname, "../../stores/src/qualification-learning-hold-store.ts")
      ).href;
      const childCode = `
        import { activateQualificationLearningHold } from ${JSON.stringify(storeModule)};
        await activateQualificationLearningHold(process.env.MUSE_PROBE_HOLD_FILE, {
          activatedAt: "2026-07-26T06:00:00.000Z",
          holdId: "personal-agent-v1"
        });
      `;
      child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", childCode],
        {
          env: {
            ...process.env,
            MUSE_PROBE_HOLD_FILE: file
          },
          stdio: ["ignore", "ignore", "pipe"]
        }
      );
      let childStderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        childStderr += chunk.toString("utf8");
      });
      const childExit = once(child, "exit").then(([code, signal]) => {
        order.push("hold-activated");
        return { code, signal };
      });
      const earlyExit = await Promise.race([
        childExit.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 150))
      ]);
      expect(earlyExit).toBe(false);

      release.resolve();
      await mutation;
      const exit = await childExit;
      expect(exit, childStderr).toEqual({ code: 0, signal: null });
      expect(order).toEqual(["mutation-completed", "hold-activated"]);
      expect(await readFile(activeFile, "utf8")).toBe("mutation-completed");
      await expect(gate.run(async () => {
        await writeFile(activeFile, "forbidden");
      })).rejects.toMatchObject({ reason: "qualification-hold-active" });
      expect(await readFile(activeFile, "utf8")).toBe("mutation-completed");
    } finally {
      release.resolve();
      await mutation.catch(() => undefined);
      if (child && child.exitCode === null) child.kill();
    }
  }, 10_000);
});
