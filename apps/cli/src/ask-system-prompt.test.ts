import { MUSE_IDENTITY_CORE } from "@muse/prompts";
import { describe, expect, it } from "vitest";

import { buildAskSystemPrompt } from "./ask-system-prompt.js";

const BASE_PARAMS = {
  personaTemplatePreamble: "",
  personaPrompt: undefined,
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
