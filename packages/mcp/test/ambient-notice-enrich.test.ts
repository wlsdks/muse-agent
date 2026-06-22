import { describe, expect, it } from "vitest";

import { createAmbientNoticeRunner, type AmbientNoticeRule, type AmbientSignal, type ProactiveNoticeSink } from "@muse/proactivity";

const acmeRule: AmbientNoticeRule = { id: "acme", match: { window: "acme" }, message: "On the Acme doc.", title: "Acme" };

function setup(enrich?: (query: string) => Promise<string | undefined> | string | undefined) {
  const delivered: { text: string; title: string; kind: string }[] = [];
  const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
  const signal: AmbientSignal = { app: "Chrome", window: "Acme — Q3 Strategy — Google Docs" };
  const runner = createAmbientNoticeRunner({ rules: [acmeRule], sink, source: { snapshot: () => signal }, ...(enrich ? { enrich } : {}) });
  return { delivered, runner };
}

describe("createAmbientNoticeRunner — knowledge enrichment", () => {
  it("appends a Related line keyed on the ambient signal when an enricher is set", async () => {
    let askedFor: string | undefined;
    const { delivered, runner } = setup((query) => { askedFor = query; return "[notes/acme.md] bring the Q3 deck"; });
    await runner.tick();
    expect(askedFor).toBe("Acme — Q3 Strategy — Google Docs"); // keyed on the window
    expect(delivered[0]!.text).toBe("On the Acme doc. — Related: [notes/acme.md] bring the Q3 deck");
  });

  it("leaves the notice unchanged when the enricher finds nothing", async () => {
    const { delivered, runner } = setup(() => undefined);
    await runner.tick();
    expect(delivered[0]!.text).toBe("On the Acme doc.");
  });

  it("fail-soft: a throwing enricher still delivers the notice without a Related line", async () => {
    const { delivered, runner } = setup(() => { throw new Error("corpus down"); });
    await runner.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toBe("On the Acme doc.");
  });
});
