import { classifyCasualPrompt } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { ACTION_GUIDE, CASUAL_RESPONSES, META_RESPONSE } from "./commands-ask.js";

describe("CASUAL_RESPONSES — clean conversational replies for a social prompt", () => {
  it("has a reply for every kind the classifier produces", () => {
    for (const q of ["hi", "thanks", "bye"]) {
      const kind = classifyCasualPrompt(q);
      expect(kind).not.toBeNull();
      expect(CASUAL_RESPONSES[kind!]).toBeTruthy();
    }
  });

  it("carries NO citation-like token — the whole point is to skip the grounding machinery, never re-introduce it", () => {
    for (const reply of [...Object.values(CASUAL_RESPONSES), META_RESPONSE]) {
      expect(reply.length).toBeGreaterThan(0);
      expect(reply).not.toMatch(/\[(from|action|event|task|reminder|contact|command|session|feed)\b/u);
    }
  });
});

describe("ACTION_GUIDE — honest, never a false promise of action", () => {
  it("points at --with-tools and the ask-first safety, and never claims it already acted", () => {
    expect(ACTION_GUIDE).toMatch(/--with-tools/u);
    expect(ACTION_GUIDE).toMatch(/ask/iu); // surfaces the ask-before-acting safety
    // Must NOT claim the action is done — that is exactly the false promise it fixes.
    expect(ACTION_GUIDE).not.toMatch(/I'?ve (set|sent|added|created|scheduled|done)/iu);
    expect(ACTION_GUIDE).not.toMatch(/I'?ll (remind|email|set|send)/iu);
  });
});

describe("META_RESPONSE — honest, job-grouped capability description", () => {
  it("describes the REAL value prop (notes recall, honest 'I'm not sure', local) without over-claiming", () => {
    expect(META_RESPONSE).toMatch(/notes/iu);
    expect(META_RESPONSE).toMatch(/locally|local/iu);
    expect(META_RESPONSE).toMatch(/not sure/iu);
    // The over-claim the local model invents ("manage your schedule") must not be here.
    expect(META_RESPONSE).not.toMatch(/manage your schedule/iu);
  });

  it("is no longer the notes-only slice — it names the deeper jobs too (calendar, actions, chat channel)", () => {
    expect(META_RESPONSE).toMatch(/calendar/iu);
    expect(META_RESPONSE).toMatch(/Email/u);
    expect(META_RESPONSE).toMatch(/Telegram/u);
  });

  it("never over-claims an un-armed integration — shows its setup command, not 'connected'", () => {
    // The env-neutral META_RESPONSE is built with no integrations armed.
    expect(META_RESPONSE).toContain("set MUSE_GMAIL_TOKEN");
    expect(META_RESPONSE).not.toContain("Email: connected");
  });
});
