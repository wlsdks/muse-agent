import { MUSE_IDENTITY_CORE } from "@muse/prompts";
import { describe, expect, it } from "vitest";

import { buildAskSystemPrompt } from "./ask-system-prompt.js";

const BASE_PARAMS = {
  personaTemplatePreamble: "",
  personaPrompt: undefined,
  query: "",
  withTools: false,
  notesFraming: { header: "=== NOTES ===" },
  contextBlock: "context",
  taskBlock: "",
  openTasks: [],
  calendarBlock: "",
  upcomingEvents: [],
  reminderBlock: "",
  pendingReminders: [],
  contactBlock: "",
  matchedContacts: [],
  flowBlock: "",
  matchedFlows: [],
  memoryBlock: "",
  matchedMemories: [],
  shellBlock: "",
  matchedCommands: [],
  gitBlock: "",
  matchedCommits: [],
  actionBlock: "",
  matchedActions: [],
  episodeBlock: "",
  episodeHits: [],
  feedBlock: "",
  feedHeadlines: [],
  browsingBlock: "",
  browsingHits: [],
  reflectionBlock: "",
  reflectionLines: []
} as const;

describe("buildAskSystemPrompt identity", () => {
  it("carries the shared identity core", () => {
    const prompt = buildAskSystemPrompt(BASE_PARAMS);
    expect(prompt).toContain(MUSE_IDENTITY_CORE);
  });

  it("keeps the ask-specific role text alongside identity", () => {
    const prompt = buildAskSystemPrompt(BASE_PARAMS);
    expect(prompt).toContain("Answer the user's question USING ONLY the notes");
    expect(prompt).toContain("Reply in the user's preferred language");
  });

  it("carries identity on the --with-tools path too", () => {
    const prompt = buildAskSystemPrompt({ ...BASE_PARAMS, withTools: true });
    expect(prompt).toContain(MUSE_IDENTITY_CORE);
    expect(prompt).toContain("CALL the matching tool");
  });
});

describe("buildAskSystemPrompt — flows (the 13th optional grounding source)", () => {
  it("includes the AUTOMATIONS block when a flow matched this turn", () => {
    const prompt = buildAskSystemPrompt({ ...BASE_PARAMS, flowBlock: "<<flow 1 — 아침 브리핑 요약>>", matchedFlows: [{}] });
    expect(prompt).toContain("=== YOUR AUTOMATIONS (Builder flows & scheduled jobs; cite as [flow: <name>]) ===");
    expect(prompt).toContain("=== END AUTOMATIONS ===");
    expect(prompt).toContain("아침 브리핑 요약");
  });

  it("omits the AUTOMATIONS block entirely when no flow matched this turn (no empty-header prompt bloat)", () => {
    const prompt = buildAskSystemPrompt({ ...BASE_PARAMS, flowBlock: "(no matching automations)", matchedFlows: [] });
    expect(prompt).not.toContain("YOUR AUTOMATIONS");
  });
});

describe("buildAskSystemPrompt language mirroring (per-turn, volatile zone)", () => {
  const MIRROR_MARKER = "reply entirely in that same language";

  it("an English (latin-dominant, no-Hangul) query injects the deterministic mirror line", () => {
    const prompt = buildAskSystemPrompt({ ...BASE_PARAMS, query: "What did I plan for the birthday party?" });
    expect(prompt).toContain(MIRROR_MARKER);
  });

  it("a Korean query stays on the Korean default — no mirror line", () => {
    const prompt = buildAskSystemPrompt({ ...BASE_PARAMS, query: "생일 파티 준비 뭐 하기로 했었지?" });
    expect(prompt).not.toContain(MIRROR_MARKER);
  });

  it("a Korean query with Latin tech tokens riding along is still Korean (any Hangul wins)", () => {
    const prompt = buildAskSystemPrompt({ ...BASE_PARAMS, query: "React랑 Vue 비교해줘" });
    expect(prompt).not.toContain(MIRROR_MARKER);
  });

  it("the mirror line sits BELOW the stable instruction block (KV-cache prefix intact)", () => {
    const english = buildAskSystemPrompt({ ...BASE_PARAMS, query: "What did I plan?" });
    const korean = buildAskSystemPrompt({ ...BASE_PARAMS, query: "뭐 하기로 했지?" });
    const stableEnd = "say you are not sure about the rest.";
    const englishStable = english.slice(0, english.indexOf(stableEnd));
    const koreanStable = korean.slice(0, korean.indexOf(stableEnd));
    expect(englishStable).toBe(koreanStable);
  });
});
