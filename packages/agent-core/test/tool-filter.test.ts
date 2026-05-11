import { describe, expect, it } from "vitest";
import type { MuseTool, MuseToolDefinition } from "@muse/tools";

import { DefaultToolFilter, inferDomain } from "../src/tool-filter.js";

function tool(definition: MuseToolDefinition): MuseTool {
  return { definition, execute: () => "ok" };
}

const tools: readonly MuseTool[] = [
  tool({ description: "Send slack", domain: "messaging", inputSchema: {}, name: "muse.messaging.send", risk: "write" }),
  tool({ description: "Read calendar", domain: "calendar", inputSchema: {}, name: "muse.calendar.upcoming", risk: "read" }),
  tool({ description: "Get time", domain: "core", inputSchema: {}, name: "muse.time.now", risk: "read" }),
  tool({ description: "Note search", domain: "notes", inputSchema: {}, name: "muse.notes.search", risk: "read" }),
  tool({ description: "No domain", inputSchema: {}, name: "legacy.untagged", risk: "read" })
];

describe("DefaultToolFilter", () => {
  const filter = new DefaultToolFilter();

  it("keeps core + untagged tools regardless of prompt", () => {
    const kept = filter.filter(tools, { userMessage: "completely unrelated topic" });
    expect(kept.map((t) => t.definition.name)).toContain("muse.time.now");
    expect(kept.map((t) => t.definition.name)).toContain("legacy.untagged");
    expect(kept.map((t) => t.definition.name)).not.toContain("muse.messaging.send");
  });

  it("surfaces messaging tools when prompt mentions slack", () => {
    const kept = filter.filter(tools, { userMessage: "check the slack channel" });
    expect(kept.map((t) => t.definition.name)).toContain("muse.messaging.send");
    expect(kept.map((t) => t.definition.name)).not.toContain("muse.calendar.upcoming");
  });

  it("scope hints override keyword matching", () => {
    const kept = filter.filter(tools, { scopeHints: ["calendar"], userMessage: "hi" });
    expect(kept.map((t) => t.definition.name)).toContain("muse.calendar.upcoming");
  });

  it("rejects single-character keywords that would match every prompt (iter 16)", () => {
    // A tool author who writes `keywords: ["a"]` would otherwise
    // pull this messaging tool into every English prompt — every
    // sentence contains "a". The min-length-2 guard preserves the
    // domain filter's discrimination.
    const evil = tool({
      // Different domain than the well-formed tool so the test
      // exercises the keyword guard in isolation, not domain
      // overlap via DEFAULT_DOMAIN_KEYWORDS.
      description: "Always-on noise",
      domain: "notes",
      inputSchema: {},
      keywords: ["a"],
      name: "evil.noisy",
      risk: "read"
    });
    const messagingByKeyword = tool({
      description: "Send a message",
      domain: "messaging",
      inputSchema: {},
      keywords: ["dm"],
      name: "muse.messaging.send-fancy",
      risk: "write"
    });
    const filter = new DefaultToolFilter();
    const kept = filter.filter([evil, messagingByKeyword], {
      userMessage: "completely unrelated topic that just happens to contain the letter a"
    });
    const names = kept.map((t) => t.definition.name);
    expect(names).not.toContain("evil.noisy");
    // The well-formed 2-char keyword still works when present.
    const dmHit = filter.filter([evil, messagingByKeyword], { userMessage: "send a dm please" });
    expect(dmHit.map((t) => t.definition.name)).toContain("muse.messaging.send-fancy");
    expect(dmHit.map((t) => t.definition.name)).not.toContain("evil.noisy");
  });

  it("rejects single-character entries inside DEFAULT_DOMAIN_KEYWORDS overrides (iter 16)", () => {
    const filter = new DefaultToolFilter({
      domainKeywords: { messaging: ["x", "slack"] } // "x" is too short
    });
    const messagingTool = tool({
      description: "Send",
      domain: "messaging",
      inputSchema: {},
      name: "muse.messaging.send",
      risk: "write"
    });
    // "x" appears in "fixing" but the guard must drop it.
    const kept = filter.filter([messagingTool], { userMessage: "fixing the layout bug" });
    expect(kept).toHaveLength(0);
    // "slack" still triggers.
    const kept2 = filter.filter([messagingTool], { userMessage: "post to slack" });
    expect(kept2).toHaveLength(1);
  });

  it("retains tools the agent already used on a prior turn (iter 5)", () => {
    // No messaging keyword in this turn, but the agent invoked
    // muse.messaging.send last turn — retain it so a follow-up like
    // "reply to that" can still trigger the messaging path.
    const kept = filter.filter(tools, {
      recentToolNames: ["muse.messaging.send"],
      userMessage: "reply to that"
    });
    expect(kept.map((t) => t.definition.name)).toContain("muse.messaging.send");
    // Unrelated calendar / notes still hidden — no false-positive
    // expansion from the recent set.
    expect(kept.map((t) => t.definition.name)).not.toContain("muse.calendar.upcoming");
  });
});

describe("inferDomain prefix table — registry-backed siblings (iter 47)", () => {
  // Iter 39 sibling for tool-filter. `muse.tasks-multi.*` /
  // `muse.calendar-multi.*` / `muse.notes-multi.*` are the
  // registry-backed variants the autoconfigure layer wires
  // alongside the single-provider tools. Pre-iter-47 they didn't
  // appear in `BUILTIN_PREFIX_DOMAIN`, so `inferDomain` returned
  // `undefined` and they bypassed the domain filter entirely (kept
  // for EVERY prompt regardless of relevance). Defeats the whole
  // catalog-narrowing purpose for those tools.
  it("recognises muse.tasks-multi.* as tasks", () => {
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.tasks-multi.list", risk: "read" })).toBe("tasks");
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.tasks-multi.create", risk: "write" })).toBe("tasks");
  });

  it("recognises muse.calendar-multi.* as calendar", () => {
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.calendar-multi.upcoming", risk: "read" })).toBe("calendar");
  });

  it("recognises muse.notes-multi.* as notes", () => {
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.notes-multi.search", risk: "read" })).toBe("notes");
  });

  it("recognises muse.reminders.* as tasks (reminders are task-adjacent)", () => {
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.reminders.list", risk: "read" })).toBe("tasks");
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.reminders.set", risk: "write" })).toBe("tasks");
  });

  it("multi-provider variants match the same domain keyword as single-provider siblings", () => {
    // Functional check: with the new prefix mapping, a casual
    // unrelated prompt now correctly DROPS the muse.tasks-multi
    // tool just as it drops muse.tasks. Without iter 47 the multi
    // variant would have survived the filter.
    const filter = new DefaultToolFilter();
    const singleTasks: MuseTool = tool({
      description: "List local tasks",
      inputSchema: {},
      name: "muse.tasks.list",
      risk: "read"
    });
    const multiTasks: MuseTool = tool({
      description: "List tasks across providers",
      inputSchema: {},
      name: "muse.tasks-multi.list",
      risk: "read"
    });
    const kept = filter.filter([singleTasks, multiTasks], { userMessage: "what's the weather like today?" });
    expect(kept).toHaveLength(0); // both dropped now
  });
});

describe("inferDomain prefix table (iter 5)", () => {
  it("recognises muse.skills.* as core (always-on)", () => {
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.skills.list", risk: "read" })).toBe("core");
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.skills.run", risk: "execute" })).toBe("core");
  });

  it("recognises muse.notes.* (Korean note keywords surface notes-domain tools)", () => {
    const filter = new DefaultToolFilter();
    const notesTool: MuseTool = tool({
      description: "List notes",
      inputSchema: {},
      name: "muse.notes.list",
      risk: "read"
    });
    const kept = filter.filter([notesTool], { userMessage: "내 노트 보여줘" });
    expect(kept).toHaveLength(1);
    const kept2 = filter.filter([notesTool], { userMessage: "위키 검색 좀" });
    expect(kept2).toHaveLength(1);
  });
});

describe("inferDomain", () => {
  it("returns the explicit domain when set", () => {
    expect(inferDomain({ description: "", domain: "messaging", inputSchema: {}, name: "x", risk: "read" })).toBe(
      "messaging"
    );
  });

  it("normalises explicit domains to lowercase (iter 25)", () => {
    // Before iter 25 the explicit-domain path returned the raw trimmed
    // value. A tool tagged `domain: "Messaging"` therefore landed on a
    // case-sensitive heuristics lookup that silently failed, while the
    // scope-set check was case-insensitive — asymmetric. Normalising
    // here closes the gap so every downstream comparison is consistent.
    expect(inferDomain({ description: "", domain: "Messaging", inputSchema: {}, name: "x", risk: "read" })).toBe(
      "messaging"
    );
    expect(inferDomain({ description: "", domain: " CALENDAR ", inputSchema: {}, name: "x", risk: "read" })).toBe(
      "calendar"
    );
  });

  it("falls back to prefix-based detection", () => {
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.calendar.list", risk: "read" })).toBe("calendar");
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.time.now", risk: "read" })).toBe("core");
    expect(inferDomain({ description: "", inputSchema: {}, name: "legacy.foo", risk: "read" })).toBeUndefined();
  });
});

describe("DefaultToolFilter keyword word-boundary matching (iter 36)", () => {
  it("does not match short ASCII keywords as substrings inside larger words", () => {
    // Pre-iter-36 the keyword loop used `promptLower.includes(kw)`
    // unconditionally. "dm" is a legitimate messaging keyword (Slack
    // direct message), but as a raw substring it fired on "admin",
    // "freedom", "wisdom", every accidental "...dm..." in normal
    // prose — silently expanding the tool catalog for unrelated
    // prompts. Same false-positive class iter 16 closed for
    // 1-character keywords; this is the bigger sibling.
    const filter = new DefaultToolFilter();
    const messagingTool = tool({
      description: "Send DM",
      domain: "messaging",
      inputSchema: {},
      name: "muse.messaging.send",
      risk: "write"
    });
    const kept = filter.filter([messagingTool], { userMessage: "I need to do some admin tasks today" });
    expect(kept).toHaveLength(0);
  });

  it("still matches the same short keyword when it is a real word", () => {
    const filter = new DefaultToolFilter();
    const messagingTool = tool({
      description: "Send DM",
      domain: "messaging",
      inputSchema: {},
      name: "muse.messaging.send",
      risk: "write"
    });
    const kept = filter.filter([messagingTool], { userMessage: "send a dm to bob about the launch" });
    expect(kept).toHaveLength(1);
  });

  it("CJK keywords still match as substrings (no word boundaries in CJK scripts)", () => {
    // Korean / Japanese / Chinese scripts don't use whitespace word
    // boundaries the same way ASCII does, so the substring fallback
    // is the correct semantics there. `\b` would never match between
    // two CJK chars under JS's ASCII-flavoured `\w`.
    const filter = new DefaultToolFilter();
    const calendarTool = tool({
      description: "Calendar",
      domain: "calendar",
      inputSchema: {},
      name: "muse.calendar.upcoming",
      risk: "read"
    });
    // "회의" is in DEFAULT_DOMAIN_KEYWORDS.calendar; the user
    // message embeds it inside a Korean sentence.
    const kept = filter.filter([calendarTool], { userMessage: "내일 회의가 있어?" });
    expect(kept).toHaveLength(1);
  });
});

describe("DefaultToolFilter explicit-domain case handling (iter 25)", () => {
  it("matches heuristics for tools whose explicit domain has non-lowercase casing", () => {
    // Personal-assistant users adding custom tools naturally write
    // `domain: "Messaging"` (sentence case). Before iter 25 the
    // `extraKeywords[domain]` lookup was case-sensitive while the
    // scope-set check was case-insensitive, so "post to slack" with
    // a "Messaging"-tagged tool dropped silently. After iter 25 the
    // lookup is symmetric.
    const filter = new DefaultToolFilter();
    const mixedCaseTool: MuseTool = tool({
      description: "Custom messaging integration",
      domain: "Messaging",
      inputSchema: {},
      name: "vendor.chat.send",
      risk: "write"
    });
    const kept = filter.filter([mixedCaseTool], { userMessage: "post this to slack please" });
    expect(kept.map((t) => t.definition.name)).toContain("vendor.chat.send");
  });

  it("scope hint with non-lowercase casing still matches a mixed-case tool domain", () => {
    const filter = new DefaultToolFilter();
    const mixedCaseTool: MuseTool = tool({
      description: "Custom calendar integration",
      domain: "Calendar",
      inputSchema: {},
      name: "vendor.cal.list",
      risk: "read"
    });
    const kept = filter.filter([mixedCaseTool], { scopeHints: ["CALENDAR"], userMessage: "hi" });
    expect(kept.map((t) => t.definition.name)).toContain("vendor.cal.list");
  });
});
