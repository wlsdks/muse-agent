import { describe, expect, it } from "vitest";
import type { MuseTool, MuseToolDefinition } from "@muse/tools";
import { filterToolsForContext } from "@muse/tools";

import { DefaultToolFilter, capToolsByRelevance, inferDomain, promptTokenCacheSize } from "../src/tool-filter.js";

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

describe("promptTokenCache bound", () => {
  it("does not grow without limit when classifying many distinct prompts", () => {
    // The home tool's keyword "light" makes the keyword matcher (and thus the
    // prompt-token cache) run on every classified prompt. Feed 5000 distinct
    // prompts and assert the cache stays bounded rather than retaining one
    // entry per prompt forever (the long-running-daemon leak).
    const homeTool = tool({ description: "Home", domain: "home", inputSchema: {}, keywords: ["light"], name: "home_state", risk: "read" });
    for (let i = 0; i < 5_000; i += 1) {
      capToolsByRelevance([homeTool], { maxTools: 6, userMessage: `distinct prompt number ${i.toString()} zzz` });
    }
    expect(promptTokenCacheSize()).toBeLessThanOrEqual(1_000);
  });
});

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

  it("surfaces the tasks domain for the SPACED Korean '할 일' (not just '할일')", () => {
    const taskTool = tool({ description: "list tasks", domain: "tasks", inputSchema: {}, name: "muse.tasks.search", risk: "read" });
    // Users write "할 일" with a space; the eval battery caught that the
    // no-space "할일" keyword missed it (Korean keywords match by substring).
    expect(filter.filter([taskTool], { userMessage: "내 할 일 목록 보여줘" }).map((t) => t.definition.name)).toEqual(["muse.tasks.search"]);
    expect(filter.filter([taskTool], { userMessage: "내 할일 정리" }).map((t) => t.definition.name)).toEqual(["muse.tasks.search"]);
    // and the hyphenated English "to-do" (the bare "todo" keyword missed it)
    expect(filter.filter([taskTool], { userMessage: "show my to-do list" }).map((t) => t.definition.name)).toEqual(["muse.tasks.search"]);
    expect(filter.filter([taskTool], { userMessage: "오늘 날씨" })).toEqual([]);
  });

  it("surfaces messaging for 'inbox'/'email' (not only slack/메시지)", () => {
    const inbox = tool({ description: "read inbox", domain: "messaging", inputSchema: {}, name: "muse.messaging.inbox", risk: "read" });
    expect(filter.filter([inbox], { userMessage: "check my inbox" }).map((t) => t.definition.name)).toEqual(["muse.messaging.inbox"]);
    expect(filter.filter([inbox], { userMessage: "받은 메일 확인" }).map((t) => t.definition.name)).toEqual(["muse.messaging.inbox"]);
    expect(filter.filter([inbox], { userMessage: "what's the weather" })).toEqual([]);
  });

  it("scope hints override keyword matching", () => {
    const kept = filter.filter(tools, { scopeHints: ["calendar"], userMessage: "hi" });
    expect(kept.map((t) => t.definition.name)).toContain("muse.calendar.upcoming");
  });

  it("surfaces memory-domain tools (episode/pattern) only on a recall-intent prompt", () => {
    const memTools = [
      tool({ description: "Search past sessions", domain: "memory", inputSchema: {}, name: "muse.episode.search", risk: "read" }),
      tool({ description: "List detected patterns", domain: "memory", inputSchema: {}, name: "muse.pattern.list", risk: "read" })
    ];
    // Before the "memory" keyword set existed these were gated behind a
    // nonexistent list → NEVER exposed. Now a recall prompt reaches them…
    const onRecall = filter.filter(memTools, { userMessage: "what did we discuss last session?" }).map((t) => t.definition.name);
    expect(onRecall).toEqual(["muse.episode.search", "muse.pattern.list"]);
    // …and an unrelated prompt does not (no per-turn noise).
    expect(filter.filter(memTools, { userMessage: "what's the weather in Busan?" })).toEqual([]);
  });

  it("rejects single-character keywords that would match every prompt", () => {
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

  it("rejects single-character entries inside DEFAULT_DOMAIN_KEYWORDS overrides", () => {
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

  it("retains tools the agent already used on a prior turn", () => {
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

describe("DefaultToolFilter default exposure ceiling", () => {
  // tool-calling.md #1: expose ≤5–7 tools per turn — a multi-domain prompt
  // must NOT advertise 10+ tools (degrades one-shot selection on the 12B).
  // Grounding: arXiv:2606.10209 (evict low-value tool units), 2507.21428
  // (per-turn tool-set management), BFCL IrrelAcc (over-firing == under-firing).
  function domainTool(name: string, domain: string, keywords: readonly string[]): MuseTool {
    return tool({ description: `Tool ${name}`, domain, inputSchema: {}, keywords, name, risk: "read" });
  }

  // ~10 tools whose keywords ALL match the multi-domain prompt, so the
  // UNBOUNDED filter keeps every one of them. The dominant intent is
  // calendar (the prompt repeats calendar terms), so a calendar tool is
  // the highest-relevance match. muse.calendar.upcoming is placed LAST in
  // input order so a (wrong) array-order truncation would drop it — the
  // relevance ranking must rescue it past the cut.
  const manyTools: readonly MuseTool[] = [
    domainTool("muse.tasks.list", "tasks", ["task", "todo"]),
    domainTool("muse.tasks.add", "tasks", ["task"]),
    domainTool("muse.notes.search", "notes", ["note", "memo"]),
    domainTool("muse.notes.list", "notes", ["note"]),
    domainTool("muse.messaging.send", "messaging", ["message", "email"]),
    domainTool("muse.messaging.inbox", "messaging", ["email", "inbox"]),
    domainTool("muse.home.lights", "home", ["light", "lamp"]),
    domainTool("muse.home.lock", "home", ["lock", "door"]),
    domainTool("muse.calendar.create", "calendar", ["calendar", "meeting"]),
    domainTool("muse.calendar.upcoming", "calendar", ["calendar", "meeting", "event", "schedule"])
  ];

  const multiDomainPrompt =
    "for my calendar meeting and event schedule, also my task todo, a note memo, " +
    "an email message in my inbox, and the light lamp lock door";

  it("caps advertised catalog at default ceiling, keeping most prompt-relevant, never the long tail", () => {
    const filter = new DefaultToolFilter();
    const kept = filter.filter(manyTools, { userMessage: multiDomainPrompt });
    const names = kept.map((t) => t.definition.name);

    // 1. soft ceiling of 6 is enforced (the unbounded filter would keep all 10).
    expect(kept.length).toBeLessThanOrEqual(6);

    // 2. the highest-relevance tool for the dominant (calendar) intent is retained:
    // muse.calendar.upcoming matches 4 prompt keywords, more than any other tool.
    expect(names).toContain("muse.calendar.upcoming");
  });

  it("retains a recentToolNames tool even when it would fall below the relevance cut", () => {
    const filter = new DefaultToolFilter();
    // muse.home.lock is a low-relevance tail tool (1–2 keyword hits). Without
    // the recent-set protection the cap would drop it; an in-flight follow-up
    // must keep it.
    const kept = filter.filter(manyTools, {
      recentToolNames: ["muse.home.lock"],
      userMessage: multiDomainPrompt
    });
    const names = kept.map((t) => t.definition.name);
    expect(names).toContain("muse.home.lock");
    expect(kept.length).toBeLessThanOrEqual(6);
    // the dominant-intent tool is still retained alongside the in-flight one.
    expect(names).toContain("muse.calendar.upcoming");
  });

  it("never drops core / untagged tools to satisfy the soft ceiling", () => {
    const filter = new DefaultToolFilter();
    const coreTools: readonly MuseTool[] = [
      domainTool("a.core", "core", []),
      domainTool("b.core", "core", []),
      domainTool("c.core", "core", []),
      domainTool("d.core", "core", []),
      domainTool("e.core", "core", []),
      domainTool("f.core", "core", []),
      domainTool("g.core", "core", []),
      domainTool("h.untagged" as string, undefined as unknown as string, [])
    ];
    const kept = filter.filter(coreTools, { userMessage: "anything at all" });
    // 8 mandatory (core/untagged) tools must ALL survive — the cap is a soft
    // ceiling over the OPTIONAL tail, never a guillotine on always-on tools.
    expect(kept).toHaveLength(8);
  });

  it("respects an explicit larger maxTools when supplied", () => {
    const filter = new DefaultToolFilter({ maxTools: 10 });
    const kept = filter.filter(manyTools, { userMessage: multiDomainPrompt });
    expect(kept).toHaveLength(10);
  });
});

describe("inferDomain prefix table — registry-backed siblings", () => {
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

describe("inferDomain prefix table", () => {
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

  it("normalises explicit domains to lowercase", () => {
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

describe("DefaultToolFilter keyword word-boundary matching", () => {
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

describe("DefaultToolFilter explicit-domain case handling", () => {
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

describe("inflection-aware keyword matching (agrees with @muse/tools selection)", () => {
  function readTool(name: string, domain: string, keywords: readonly string[]): MuseTool {
    return tool({ description: `Tool ${name}`, domain, inputSchema: {}, keywords, name, risk: "read" });
  }

  it("capToolsByRelevance keeps the inflection-matched tool past the cap", () => {
    // "turn off the lights" — keyword "light" must score via the inflected
    // token "lights" (token.startsWith(word), suffix ≤3), the SAME rule
    // @muse/tools selection ranks it by. The home tool uses a CUSTOM domain
    // ("smarthome", absent from DEFAULT_DOMAIN_KEYWORDS) so the ONLY thing
    // that can score it is its own keyword — isolating the inflection rule
    // from the built-in heuristics (which happen to list both "light" AND
    // "lights"). Under the old strict `\blight\b` it scores 0. None of the
    // filler keywords match the prompt either, so they also score 0 — and
    // because home_state is placed LAST in input order, a strict matcher
    // sorts it to the very tail and the cap (6 of 7) evicts it. The
    // inflection score of 1 is what rescues it. Seven optional tools so the
    // cap truncates by exactly one.
    const tools: readonly MuseTool[] = [
      readTool("muse.tasks.list", "tasks", ["task"]),
      readTool("muse.tasks.add", "tasks", ["todo"]),
      readTool("muse.notes.search", "notes", ["note"]),
      readTool("muse.notes.list", "notes", ["memo"]),
      readTool("muse.messaging.send", "messaging", ["message"]),
      readTool("muse.calendar.create", "calendar", ["meeting"]),
      readTool("home_state", "smarthome", ["light"])
    ];

    const kept = capToolsByRelevance(tools, {
      maxTools: 6,
      userMessage: "turn off the lights"
    });
    const names = kept.map((t) => t.definition.name);

    expect(kept.length).toBeLessThanOrEqual(6);
    expect(names).toContain("home_state");
  });

  it("does NOT starve a task-relevant OPTIONAL tool when always-on mandatory tools alone fill the cap", () => {
    // The structural bug computer-control fires 1-4 chased: a large always-on
    // mandatory set (core/untagged tools, here 7) exceeds the cap of 6, so the
    // optional tail is dropped ENTIRELY (remaining=0) — making file_edit, the
    // tool the user's "fix the file" task NEEDS, INVISIBLE to the model. The fix
    // reserves slots for positively-relevant optional tools so a needed tool is
    // never starved by always-on clutter.
    const core = (name: string): MuseTool => tool({ description: name, domain: "core", inputSchema: {}, name, risk: "read" });
    const fileT = (name: string): MuseTool => tool({ description: name, domain: "files", inputSchema: {}, keywords: ["file"], name, risk: "write" });
    const tools: readonly MuseTool[] = [
      core("c1"), core("c2"), core("c3"), core("c4"), core("c5"), core("c6"), core("c7"),
      // a generic keyword-relevant optional tool that would otherwise out-tie a file tool
      tool({ description: "search notes", domain: "notes", inputSchema: {}, keywords: ["find"], name: "muse.notes.search", risk: "read" }),
      fileT("file_read"), fileT("file_grep"), fileT("file_edit")
    ];
    // the prompt names a FILE PATH → the files-domain cluster is boosted so all
    // THREE file tools (incl. file_edit, the tool that actually performs the fix)
    // survive together, not just the highest-ordered one.
    const kept = capToolsByRelevance(tools, { maxTools: 6, userMessage: "find the file that defines add in /tmp/proj/src/math-utils.mjs and fix it" });
    const names = kept.map((t) => t.definition.name);
    expect(names).toContain("file_edit");
    expect(names).toContain("file_read");
    expect(names).toContain("file_grep");
  });

  it("reserves the execute tool on a RUN task so the file cluster doesn't starve run_command (edit-run-verify)", () => {
    // A "fix the file AND run the test" task needs the 3 file tools AND the runner.
    // The 3-slot file reserve would otherwise drop run_command (rank 4) so the
    // model fixes the bug but can never RUN to verify.
    const core = (name: string): MuseTool => tool({ description: name, domain: "core", inputSchema: {}, name, risk: "read" });
    const fileT = (name: string): MuseTool => tool({ description: name, domain: "files", inputSchema: {}, keywords: ["file"], name, risk: "write" });
    const tools: readonly MuseTool[] = [
      core("c1"), core("c2"), core("c3"), core("c4"), core("c5"), core("c6"), core("c7"),
      fileT("file_read"), fileT("file_grep"), fileT("file_edit"),
      tool({ description: "run a command", domain: "system", inputSchema: {}, keywords: ["run", "test", "execute"], name: "run_command", risk: "execute" })
    ];
    const kept = capToolsByRelevance(tools, { maxTools: 6, userMessage: "fix the bug in /tmp/proj/src/sum.mjs and run the test to verify" }).map((t) => t.definition.name);
    // Both the file cluster AND the runner survive (the model can edit AND verify).
    expect(kept).toContain("file_edit");
    expect(kept).toContain("run_command");
  });

  it("does NOT reserve the execute tool when there is NO run intent (no over-exposure of the runner)", () => {
    const core = (name: string): MuseTool => tool({ description: name, domain: "core", inputSchema: {}, name, risk: "read" });
    const fileT = (name: string): MuseTool => tool({ description: name, domain: "files", inputSchema: {}, keywords: ["file"], name, risk: "write" });
    const tools: readonly MuseTool[] = [
      core("c1"), core("c2"), core("c3"), core("c4"), core("c5"), core("c6"), core("c7"),
      fileT("file_read"), fileT("file_grep"), fileT("file_edit"),
      tool({ description: "run a command", domain: "system", inputSchema: {}, keywords: ["run", "test", "execute"], name: "run_command", risk: "execute" })
    ];
    // A pure read/inspect task with no run/test/build intent.
    const kept = capToolsByRelevance(tools, { maxTools: 6, userMessage: "open /tmp/proj/src/sum.mjs and explain what the function does" }).map((t) => t.definition.name);
    expect(kept).not.toContain("run_command");
  });

  it("still drops an IRRELEVANT optional tool when mandatory fills the cap (no clutter past the cap)", () => {
    const core = (name: string): MuseTool => tool({ description: name, domain: "core", inputSchema: {}, name, risk: "read" });
    const tools: readonly MuseTool[] = [
      core("c1"), core("c2"), core("c3"), core("c4"), core("c5"), core("c6"), core("c7"),
      tool({ description: "send slack", domain: "messaging", inputSchema: {}, keywords: ["slack", "message"], name: "muse.messaging.send", risk: "write" })
    ];
    const kept = capToolsByRelevance(tools, { maxTools: 6, userMessage: "find the file that defines add and fix it" });
    expect(kept.map((t) => t.definition.name)).not.toContain("muse.messaging.send");
  });

  it("shouldKeep keeps a domain tool on an inflected prompt", () => {
    // Custom domain so the keyword (not the built-in heuristics) is the only
    // thing that can retain the tool — exercises the inflected keyword path.
    const filter = new DefaultToolFilter();
    const homeTool = readTool("home_state", "smarthome", ["light"]);
    const kept = filter.filter([homeTool], { userMessage: "turn off the lights" });
    expect(kept.map((t) => t.definition.name)).toContain("home_state");
  });

  it("@muse/tools selection ALSO selects the tool — the two layers agree", () => {
    const homeTool = readTool("home_state", "smarthome", ["light"]);
    const selection = filterToolsForContext([homeTool], {
      maxTools: 6,
      prompt: "turn off the lights"
    });
    expect(selection.tools.map((t) => t.definition.name)).toContain("home_state");
  });

  it("over-match guard: inflection rule does not introduce IrrelAcc regressions", () => {
    const filter = new DefaultToolFilter();

    // "research" must NOT satisfy keyword "search" (prefix start matches, but
    // suffix is >3 chars: research = search? no — research does not start with
    // search). Use the precise pair the @muse/tools comment pins.
    const searchTool = readTool("knowledge.search", "notes", ["search"]);
    expect(
      filter.filter([searchTool], { userMessage: "i did some research today" })
    ).toHaveLength(0);

    // "homework" must NOT satisfy keyword "home" (suffix "work" = 4 chars > 3).
    const homeTool = readTool("home_state", "home", ["home"]);
    expect(
      filter.filter([homeTool], { userMessage: "i finished my homework" })
    ).toHaveLength(0);

    // Short words (<4 chars) require an EXACT token: "on"/"off" must not
    // prefix-match inside larger words.
    const shortTool = readTool("toggle.power", "home", ["on", "off"]);
    expect(
      filter.filter([shortTool], { userMessage: "the offer is online only" })
    ).toHaveLength(0);
    // …but the same short keyword still matches as a standalone token.
    expect(
      filter.filter([shortTool], { userMessage: "turn it off" })
    ).toHaveLength(1);
  });

  it("over-match guard (CJK): a single-char word in a multi-word keyword must not match by containment", () => {
    const filter = new DefaultToolFilter();
    // Mirrors @muse/tools' `word.length >= 2 ? token.includes(word) : false`
    // guard. The shipped tasks keyword "할 일" splits into single CJK chars
    // ["할","일"]. They must match only as EXACT tokens, never contained inside
    // a larger token — else an unrelated Korean prompt ("할머니"=grandmother,
    // "일했다"=worked) over-fires the tasks domain, disagreeing with the
    // selection layer (the exact fire-5 judge finding).
    const taskTool = readTool("muse.tasks.search", "tasks", ["할 일"]);
    // unrelated: "할" only inside "할머니가", "일" only inside "일했다" → no match
    expect(
      filter.filter([taskTool], { userMessage: "할머니가 일했다는 이야기" })
    ).toHaveLength(0);
    // genuine task ask: bare "할" and "일" tokens present → still matches
    expect(
      filter.filter([taskTool], { userMessage: "내 할 일 목록 보여줘" }).map((t) => t.definition.name)
    ).toEqual(["muse.tasks.search"]);
  });
});
