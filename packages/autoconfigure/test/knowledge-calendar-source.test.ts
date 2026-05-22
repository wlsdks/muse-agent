import { describe, expect, it } from "vitest";

import {
  assembleKnowledgeCorpus,
  createNotesKnowledgeSearchTool,
  type CalendarEventLike,
  type CalendarEventSource
} from "../src/knowledge-corpus.js";

const VOCAB = ["acme", "strategy", "renewal", "dentist"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

// A contract-faithful calendar source that honours the queried range.
function calendarSource(events: readonly CalendarEventLike[]): CalendarEventSource {
  return { listEvents: ({ from, to }) => events.filter((e) => e.startsAt >= from && e.startsAt <= to) };
}

const DAY = 86_400_000;

describe("assembleKnowledgeCorpus — calendar as a windowed corpus source", () => {
  it("includes recent+upcoming events as event/<id>, excludes out-of-window ones", async () => {
    const NOW = Date.parse("2026-05-23T12:00:00Z");
    const source = calendarSource([
      { id: "ev1", notes: "discuss the Acme renewal", startsAt: new Date(NOW + 2 * DAY), title: "Acme strategy meeting" },
      { id: "ev-old", startsAt: new Date(NOW - 60 * DAY), title: "Old standup" },
      { id: "ev-far", startsAt: new Date(NOW + 60 * DAY), title: "Far future offsite" }
    ]);
    const corpus = await assembleKnowledgeCorpus({ calendarSource: source, now: () => NOW });
    const sources = corpus.map((chunk) => chunk.source);
    expect(sources).toEqual(["event/ev1"]);
    expect(corpus[0]!.text).toContain("Acme strategy meeting");
    expect(corpus[0]!.text).toContain("renewal");
  });
});

describe("knowledge_search spans the calendar — finds + cites an event", () => {
  it("answers from a recent event and cites event/<id>", async () => {
    const source = calendarSource([
      { id: "evX", location: "Room 4", notes: "discuss the Acme renewal terms", startsAt: new Date(Date.now() + 2 * DAY), title: "Acme strategy meeting" }
    ]);
    const tool = createNotesKnowledgeSearchTool({ calendarSource: source, embed });
    const result = String(await tool.execute({ query: "what's the acme renewal meeting about?" }, { runId: "r1" }));
    expect(result).toContain("[event/evX]");
    expect(result).toContain("Acme strategy meeting");
  });
});
