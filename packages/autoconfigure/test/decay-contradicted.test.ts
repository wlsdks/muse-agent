import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isInjectableStrategy, PLAYBOOK_AVOID_BELOW, type CorrectionPolarity } from "@muse/agent-core";
import {
  readPlaybook,
  recordPlaybookStrategy as recordPlaybookStrategyImpl,
  setLearningPaused,
  type ActivePlaybookWriteGate,
  type PlaybookEntry,
  queryPlaybook
} from "@muse/stores";
import type { ModelProvider } from "@muse/model";
import { afterEach, describe, expect, it } from "vitest";

import { decayContradictedStrategies } from "../src/decay-contradicted.js";

const allowActivePlaybookWrites: ActivePlaybookWriteGate = {
  run: (operation) => operation()
};
const recordPlaybookStrategy = (file: string, entry: PlaybookEntry) =>
  recordPlaybookStrategyImpl(file, entry, allowActivePlaybookWrites);

const tmps: string[] = [];
function freshFile(label: string): string {
  const file = join(tmpdir(), `muse-${label}-${randomUUID()}.json`);
  tmps.push(file);
  return file;
}
afterEach(async () => { await Promise.all(tmps.splice(0).map((f) => rm(f, { force: true }))); });

// The model is never called — the polarity classifier is injected.
const modelProvider: Pick<ModelProvider, "generate"> = {
  generate: async () => { throw new Error("model should not be called — classify is injected"); }
};

const injected = (over: Partial<PlaybookEntry> = {}): PlaybookEntry => ({
  createdAt: "2026-06-01T00:00:00Z", id: `inj-${randomUUID()}`, origin: "distilled",
  probation: false, reward: 3, text: "Give thorough, detailed multi-paragraph answers.", userId: "u", ...over
});

const base = (playbookFile: string, classify: (c: string, s: string) => Promise<CorrectionPolarity>) => ({
  activeWriteGate: allowActivePlaybookWrites,
  classify, corrections: [{ id: "pb-new", text: "Stop giving me essays — answer in one sentence." }],
  model: "qwen3:8b", modelProvider, playbookFile, userId: "u"
});

const always = (v: CorrectionPolarity) => async (): Promise<CorrectionPolarity> => v;

describe("decayContradictedStrategies — sign-safe autonomous correction-decay", () => {
  it("a CONTRADICT correction drops an injected strategy to the avoid floor → it stops being injected", async () => {
    const file = freshFile("playbook");
    const strat = injected();
    await recordPlaybookStrategy(file, strat);

    const decayed = await decayContradictedStrategies(base(file, always("contradict")));
    expect(decayed.map((d) => d.id)).toEqual([strat.id]);

    const after = (await readPlaybook(file)).find((e) => e.id === strat.id)!;
    expect(after.reward).toBe(PLAYBOOK_AVOID_BELOW);
    expect(isInjectableStrategy(after)).toBe(false); // no longer applied — reversible by a reward
    expect(after.probation).toBe(false); // decay-only: probation flag untouched
  });

  it.each(["agree", "unrelated", "uncertain"] as const)("a %s verdict NEVER decays (fail-closed)", async (verdict) => {
    const file = freshFile("playbook");
    const strat = injected();
    await recordPlaybookStrategy(file, strat);

    const decayed = await decayContradictedStrategies(base(file, always(verdict)));
    expect(decayed).toEqual([]);
    const after = (await readPlaybook(file)).find((e) => e.id === strat.id)!;
    expect(after.reward).toBe(3); // untouched
    expect(isInjectableStrategy(after)).toBe(true);
  });

  it("NEVER touches a PROBATION strategy, even if the correction would contradict it (injected-only)", async () => {
    const file = freshFile("playbook");
    const prob = injected({ probation: true, reward: 0, text: "Use a warm sign-off." });
    await recordPlaybookStrategy(file, prob);

    const decayed = await decayContradictedStrategies(base(file, always("contradict")));
    expect(decayed).toEqual([]); // a probation strategy isn't applied, so it's not a target
    const after = (await readPlaybook(file)).find((e) => e.id === prob.id)!;
    expect(after.probation).toBe(true);
    expect(after.reward).toBe(0);
  });

  it("NEVER graduates: a contradicting correction cannot raise a reward or clear probation anywhere", async () => {
    const file = freshFile("playbook");
    const inj = injected();
    const prob = injected({ probation: true, reward: 0, id: "prob-x", text: "Be concise." });
    await recordPlaybookStrategy(file, inj);
    await recordPlaybookStrategy(file, prob);

    await decayContradictedStrategies(base(file, always("contradict")));
    const after = await readPlaybook(file);
    expect(after.every((e) => (e.reward ?? 0) <= (e.id === inj.id ? 3 : 0))).toBe(true); // no reward rose
    expect(after.find((e) => e.id === "prob-x")!.probation).toBe(true); // no probation cleared
  });

  it("respects maxClassifications (bounded model spend per tick)", async () => {
    const file = freshFile("playbook");
    await recordPlaybookStrategy(file, injected({ id: "a", text: "rule A" }));
    await recordPlaybookStrategy(file, injected({ id: "b", text: "rule B" }));
    await recordPlaybookStrategy(file, injected({ id: "c", text: "rule C" }));
    let calls = 0;
    const classify = async (): Promise<CorrectionPolarity> => { calls += 1; return "unrelated"; };
    await decayContradictedStrategies({ ...base(file, classify), maxClassifications: 2 });
    expect(calls).toBe(2);
  });

  it("is a no-op with no recent corrections, and a no-op when no strategy is injected", async () => {
    const file = freshFile("playbook");
    await recordPlaybookStrategy(file, injected({ probation: true })); // only probation present
    expect(await decayContradictedStrategies({ ...base(file, always("contradict")), corrections: [] })).toEqual([]);
    expect(await decayContradictedStrategies(base(file, always("contradict")))).toEqual([]); // nothing injected to decay
  });

  it("BRAKE: a paused learner's bank is frozen — no classification, no decay", async () => {
    const file = freshFile("playbook");
    const pauseFile = freshFile("pause");
    await recordPlaybookStrategy(file, injected());
    await setLearningPaused(pauseFile, true);
    let calls = 0;
    const classify = async (): Promise<CorrectionPolarity> => { calls += 1; return "contradict"; };
    const decayed = await decayContradictedStrategies({ ...base(file, classify), pauseFile });
    expect(decayed).toEqual([]);
    expect(calls).toBe(0);
    expect((await readPlaybook(file))[0]!.reward).toBe(3);
  });
});

/**
 * Independent-review regression pin: while the decay gate's cosine floor sat
 * above the reachable band it had NEVER fired, so nothing could be unlearned.
 * The moment it was calibrated, an offhand correction could silently unlearn a
 * rule the USER wrote ("Never send an email without showing me the text first"
 * → decayed to the avoid floor by "just send it directly"). Origin is the guard:
 * unattended decay may only touch what Muse itself inferred.
 */
describe("decayContradictedStrategies — never unlearns what the USER authored", () => {
  it("leaves a hand-written (origin:manual) strategy untouched even on a confident CONTRADICT", async () => {
    const file = freshFile("playbook-manual");
    const manual = injected({
      origin: "manual",
      text: "Never send an email to a third party without showing me the exact text first."
    });
    await recordPlaybookStrategy(file, manual);
    const decayed = await decayContradictedStrategies({
      ...base(file, async () => "contradict" as const),
      corrections: ["stop showing me drafts — from now on just send the email directly"]
    });
    expect(decayed).toEqual([]);
    const after = await queryPlaybook(file, "u");
    expect(after[0]?.reward).toBe(manual.reward);
  });

  it("leaves an evidence-grounded strategy untouched too", async () => {
    const file = freshFile("playbook-grounded");
    await recordPlaybookStrategy(file, injected({ origin: "grounded", text: "Cite the note or file every claim came from." }));
    const decayed = await decayContradictedStrategies({
      ...base(file, async () => "contradict" as const),
      corrections: ["stop citing notes in every answer, it's noisy"]
    });
    expect(decayed).toEqual([]);
  });
});
