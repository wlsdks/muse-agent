import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import {
  enqueueLearnEvent,
  queryPlaybook,
  readPendingLearnEvents
} from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeSelfLearnTick, type MakeSelfLearnTickDeps } from "./daemon-selflearn-ticks.js";
import { defaultFollowupModel } from "./commands-daemon-connections.js";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-selflearn-local-only-"));
  env = {
    HOME: dir,
    MUSE_LEARN_QUEUE_FILE: join(dir, "learn-queue.jsonl"),
    MUSE_LEARNING_PAUSE_FILE: join(dir, "learning-pause.json"),
    MUSE_LOCAL_ONLY: "true",
    MUSE_PLAYBOOK_FILE: join(dir, "playbook.json"),
    MUSE_QUALIFICATION_LEARNING_HOLD_FILE: join(dir, "qualification-learning-hold.json"),
    MUSE_SELFLEARN_ENABLED: "true",
    MUSE_SUPPRESSED_LESSONS_FILE: join(dir, "suppressed-lessons.json")
  };
  await enqueueLearnEvent(env.MUSE_LEARN_QUEUE_FILE!, {
    correction: "No — standup moved to 9:30am on Mondays.",
    enqueuedAtMs: 1,
    id: "correction-1",
    priorAnswer: "Your standup is at 10am.",
    request: "When is my Monday standup?",
    userId: "u1"
  });
  await writeFile(env.MUSE_PLAYBOOK_FILE!, "[]\n", "utf8");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

function makeDeps(
  followupModel: NonNullable<MakeSelfLearnTickDeps["followupModel"]>,
  overrides: Partial<MakeSelfLearnTickDeps> = {}
): MakeSelfLearnTickDeps {
  return {
    env,
    followupModel,
    intervalMs: 60_000,
    lastRunMs: { current: undefined },
    noticeSink: { deliver: vi.fn(async () => undefined) },
    stdout: vi.fn(),
    ...overrides
  };
}

describe("daemon self-learning local-only auxiliary egress gate", () => {
  it("fails closed when local-only model locality provenance is unavailable", async () => {
    const generate = vi.fn();
    const claim = vi.fn(() => true);
    const tick = makeSelfLearnTick(makeDeps({
      model: "unknown/test-model",
      modelProvider: { generate } as never
    }));

    await expect(tick(claim)).resolves.toEqual({
      reason: "local-only-auxiliary-unavailable",
      status: "not-ready"
    });
    expect(generate).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("refuses a cloud auxiliary before claim, model egress, or persistent mutation", async () => {
    const generate = vi.fn(async () => {
      throw new Error("cloud provider must not be called");
    });
    const queueBefore = await readFile(env.MUSE_LEARN_QUEUE_FILE!, "utf8");
    const playbookBefore = await readFile(env.MUSE_PLAYBOOK_FILE!, "utf8");
    const lastRunMs = { current: undefined };
    const claim = vi.fn(() => true);
    const tick = makeSelfLearnTick(makeDeps({
      locality: "cloud",
      model: "openai/gpt-4o-mini",
      modelProvider: { generate } as never
    }, { lastRunMs }));

    await expect(tick(claim)).resolves.toEqual({
      reason: "local-only-auxiliary-unavailable",
      status: "not-ready"
    });
    expect(generate).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(lastRunMs.current).toBeUndefined();
    await expect(readFile(env.MUSE_LEARN_QUEUE_FILE!, "utf8")).resolves.toBe(queueBefore);
    await expect(readFile(env.MUSE_PLAYBOOK_FILE!, "utf8")).resolves.toBe(playbookBefore);
    await expect(readPendingLearnEvents(env.MUSE_LEARN_QUEUE_FILE!)).resolves.toHaveLength(1);
  });

  it("keeps the existing distill path available for a proven local auxiliary", async () => {
    const distill = vi.fn(async () => ({
      tag: "scheduling",
      text: "Monday standup is at 9:30am, not 10am."
    }));
    const claim = vi.fn(() => true);
    const tick = makeSelfLearnTick(makeDeps({
      locality: "local",
      model: "ollama/qwen3.5:9b",
      modelProvider: { generate: vi.fn() } as never
    }, { selfLearnDistill: distill }));

    await expect(tick(claim)).resolves.toEqual({ status: "claimed-completed" });
    expect(claim).toHaveBeenCalledOnce();
    expect(distill).toHaveBeenCalled();
    await expect(readPendingLearnEvents(env.MUSE_LEARN_QUEUE_FILE!)).resolves.toHaveLength(0);
    await expect(queryPlaybook(env.MUSE_PLAYBOOK_FILE!, "u1")).resolves.toHaveLength(1);
  });
});

describe("default daemon auxiliary locality provenance", () => {
  it("uses the assembly's models.json-merged remote Ollama locality", async () => {
    const modelKeysFile = join(dir, "models.json");
    await writeFile(modelKeysFile, JSON.stringify({
      providers: {
        ollama: {
          suggestedModel: "ollama/qwen3:8b",
          token: "http://remote-ollama.example:11434"
        }
      }
    }), "utf8");

    const remoteEnv = {
      HOME: dir,
      MUSE_LOCAL_ONLY: "false",
      MUSE_MODEL_KEYS_FILE: modelKeysFile
    };
    const assembly = createMuseRuntimeAssembly({ env: remoteEnv });
    const resolved = await defaultFollowupModel(remoteEnv);

    expect(assembly.modelProviderLocality).toBe("cloud");
    expect(resolved).toMatchObject({
      locality: "cloud",
      model: "ollama/qwen3:8b"
    });
  });

  it("surfaces local-only auxiliary unavailability when assembly rejects that remote transport", async () => {
    const modelKeysFile = join(dir, "models.json");
    await writeFile(modelKeysFile, JSON.stringify({
      providers: {
        ollama: {
          suggestedModel: "ollama/qwen3:8b",
          token: "http://remote-ollama.example:11434"
        }
      }
    }), "utf8");
    const localOnlyEnv = {
      ...env,
      MUSE_MODEL_KEYS_FILE: modelKeysFile
    };
    const followupModel = await defaultFollowupModel(localOnlyEnv);
    const claim = vi.fn(() => true);
    const tick = makeSelfLearnTick(makeDeps(followupModel as never, {
      env: localOnlyEnv
    }));

    expect(followupModel).toBeUndefined();
    await expect(tick(claim)).resolves.toEqual({
      reason: "local-only-auxiliary-unavailable",
      status: "not-ready"
    });
    expect(claim).not.toHaveBeenCalled();
  });
});
