import { describe, expect, it } from "vitest";

import { createAmbientNoticeRunner, knowledgeAmbientQuery, type AmbientSignal, type ProactiveNoticeSink } from "@muse/proactivity";

/**
 * SB-3 knowledge-triggered ambient notice: the active WINDOW TITLE alone
 * connects the user to what they already wrote — no pre-authored rule.
 * The `enrich` fake stands in for the embedding-RAG enricher (a real
 * round-trip is covered by the live smoke), returning a related line
 * only when the query connects.
 */
function setup(connect: (query: string) => string | undefined) {
  let current: AmbientSignal | undefined;
  const delivered: { text: string; title: string; kind: string }[] = [];
  const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
  const runner = createAmbientNoticeRunner({
    rules: [],
    sink,
    source: { snapshot: () => current },
    knowledgeTrigger: { enrich: (query) => connect(query) }
  });
  return { delivered, runner, set: (signal: AmbientSignal | undefined) => { current = signal; } };
}

describe("knowledgeAmbientQuery — window title only", () => {
  it("uses the window title and nothing else", () => {
    expect(knowledgeAmbientQuery({ window: "Q3 budget — Notion", app: "Notion", clipboard: "secret" })).toBe("Q3 budget — Notion");
  });
  it("is empty (suppressed) when there is no window title", () => {
    expect(knowledgeAmbientQuery({ app: "Notion", clipboard: "secret", selected: "stuff" })).toBe("");
    expect(knowledgeAmbientQuery(undefined)).toBe("");
  });
});

describe("createAmbientNoticeRunner — knowledge-triggered (no rule needed)", () => {
  it("fires when the window title connects to the corpus, with the connection as the notice body", async () => {
    const { delivered, runner, set } = setup((q) =>
      q.toLowerCase().includes("q3 budget") ? "[notes/finance.md] Q3 ad spend capped at 12k" : undefined);

    set({ window: "Q3 budget — Notion" });
    expect((await runner.tick()).delivered).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain("Q3 ad spend capped at 12k");
    expect(delivered[0]?.kind).toBe("ambient");
  });

  it("edge-trigger: same connection does not re-fire while it keeps surfacing, re-arms after it clears", async () => {
    const { delivered, runner, set } = setup((q) =>
      q.toLowerCase().includes("budget") ? "[notes/finance.md] capped at 12k" : undefined);

    set({ window: "Q3 budget" });
    expect((await runner.tick()).delivered).toBe(1); // rising edge

    expect((await runner.tick()).delivered).toBe(0); // same connection → no re-fire

    set({ window: "Spotify" });
    expect((await runner.tick()).delivered).toBe(0); // no connection → silent, re-arms

    set({ window: "annual budget review" });
    expect((await runner.tick()).delivered).toBe(1); // connects again → fires
    expect(delivered).toHaveLength(2);
  });

  it("a different connection fires even back-to-back", async () => {
    const { delivered, runner, set } = setup((q) =>
      q.includes("budget") ? "[notes/a] budget note" : q.includes("trip") ? "[notes/b] trip note" : undefined);

    set({ window: "budget" });
    expect((await runner.tick()).delivered).toBe(1);
    set({ window: "trip plan" });
    expect((await runner.tick()).delivered).toBe(1);
    expect(delivered.map((d) => d.text)).toEqual(["[notes/a] budget note", "[notes/b] trip note"]);
  });

  it("stays silent when there is no window title (clipboard/app are not used as the query)", async () => {
    const { delivered, runner, set } = setup(() => "[notes/x] should not surface");
    set({ app: "Notion", clipboard: "Q3 budget", selected: "Q3 budget" });
    expect((await runner.tick()).delivered).toBe(0);
    expect(delivered).toHaveLength(0);
  });

  it("fail-soft: a throwing enricher delivers nothing and does not crash the tick", async () => {
    const { delivered, runner, set } = setup(() => { throw new Error("embedder down"); });
    set({ window: "Q3 budget" });
    expect((await runner.tick()).delivered).toBe(0);
    expect(delivered).toHaveLength(0);
  });

  it("a delivery failure does not consume the edge — re-fires next tick", async () => {
    let calls = 0;
    const sink: ProactiveNoticeSink = {
      deliver: () => { calls += 1; if (calls === 1) throw new Error("messaging down"); }
    };
    const signal: AmbientSignal = { window: "Q3 budget" };
    const runner = createAmbientNoticeRunner({
      rules: [],
      sink,
      source: { snapshot: () => signal },
      knowledgeTrigger: { enrich: () => "[notes/finance.md] capped at 12k" }
    });
    expect((await runner.tick()).delivered).toBe(0); // deliver threw → not deduped
    expect((await runner.tick()).delivered).toBe(1); // re-fires, succeeds
    expect(calls).toBe(2);
  });

  it("delivers the enrich() result verbatim — no rule-match rationale clause (no field/pattern evidence exists to build one from)", async () => {
    const { delivered, runner, set } = setup((q) =>
      q.toLowerCase().includes("q3 budget") ? "[notes/finance.md] Q3 ad spend capped at 12k" : undefined);
    set({ window: "Q3 budget — Notion" });
    await runner.tick();
    expect(delivered[0]?.text).toBe("[notes/finance.md] Q3 ad spend capped at 12k");
  });

  it("uses the configured title", async () => {
    let current: AmbientSignal | undefined = { window: "Q3 budget" };
    const delivered: { title: string }[] = [];
    const sink: ProactiveNoticeSink = { deliver: (n) => { delivered.push(n); } };
    const runner = createAmbientNoticeRunner({
      rules: [],
      sink,
      source: { snapshot: () => current },
      knowledgeTrigger: { enrich: () => "[notes/x] note", title: "🧠 Recall" }
    });
    await runner.tick();
    current = undefined;
    expect(delivered[0]?.title).toBe("🧠 Recall");
  });
});
