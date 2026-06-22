import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalDirNotesProvider } from "@muse/domain-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createKnowledgeEnricher, type CalendarEventLike, type CalendarEventSource } from "../src/knowledge-corpus.js";

const VOCAB = ["acme", "prep", "deck", "strategy", "meeting"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

function calendarSource(events: readonly CalendarEventLike[]): CalendarEventSource {
  return { listEvents: () => events };
}

let notesDir: string;
beforeEach(async () => {
  notesDir = await mkdtemp(join(tmpdir(), "muse-enrich-ex-"));
  // Confident note (shares acme+strategy, not "meeting") so the CRAG gate
  // surfaces it, while the exact-match event still ranks #1 without exclusion —
  // this test exercises exclusion ROUTING, not the weak-match threshold.
  await writeFile(join(notesDir, "acme.md"), "Acme strategy deck prep.", "utf8");
});
afterEach(async () => {
  await rm(notesDir, { force: true, recursive: true });
});

const event: CalendarEventLike = { id: "ev1", startsAt: new Date(), title: "Acme strategy meeting" };

describe("createKnowledgeEnricher — excludeSourcePrefixes avoids echoing the imminent item", () => {
  it("WITHOUT exclusion, a query matching a calendar event surfaces that event (the echo to avoid)", async () => {
    const enrich = createKnowledgeEnricher({
      calendarSource: calendarSource([event]),
      embed,
      notesProvider: new LocalDirNotesProvider({ notesDir })
    });
    expect(await enrich("Acme strategy meeting")).toContain("[event/Acme strategy meeting]");
  });

  it("WITH excludeSourcePrefixes:[event/] it surfaces the NOTE instead — genuine context, no echo", async () => {
    const enrich = createKnowledgeEnricher({
      calendarSource: calendarSource([event]),
      embed,
      excludeSourcePrefixes: ["event/", "task/"],
      notesProvider: new LocalDirNotesProvider({ notesDir })
    });
    const line = await enrich("Acme strategy meeting");
    expect(line).toContain("[notes/acme.md]");
    expect(line).not.toContain("event/");
  });
});
