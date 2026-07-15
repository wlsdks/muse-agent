/**
 * System-prompt composition for `muse ask`, lifted out of the commands-ask
 * god-file. Assembles the persona preamble, the path-specific instruction block
 * (context-locked chat-only vs tool-armed --with-tools), the citation + reasoning
 * principle lines, the volatile date/notes-framing lines (kept BELOW the stable
 * prefix for Ollama KV-cache reuse), the notes context block, and every optional
 * grounding section that has content this turn. Pure string builder — no I/O, no
 * side effects; reads only the pre-computed blocks + counts it is handed.
 */

import { composeSurfacePrompt } from "@muse/prompts";
import { groundingSectionLines, optionalGroundingRelevance, optionalGroundingSections } from "@muse/recall";

import { CITATION_INSTRUCTION_LINES, REASONING_PRINCIPLE_LINES } from "./ask-prompt-constants.js";
import { formatCurrentContextLine } from "@muse/recall";

export function buildAskSystemPrompt(params: {
  readonly personaTemplatePreamble: string;
  readonly personaPrompt: string | undefined;
  readonly withTools: boolean;
  readonly notesFraming: { readonly guidance?: string | undefined; readonly header: string };
  readonly contextBlock: string;
  readonly taskBlock: string;
  readonly openTasks: readonly unknown[];
  readonly calendarBlock: string;
  readonly upcomingEvents: readonly unknown[];
  readonly reminderBlock: string;
  readonly pendingReminders: readonly unknown[];
  readonly contactBlock: string;
  readonly matchedContacts: readonly unknown[];
  readonly memoryBlock: string;
  readonly matchedMemories: readonly unknown[];
  readonly shellBlock: string;
  readonly matchedCommands: readonly unknown[];
  readonly gitBlock: string;
  readonly matchedCommits: readonly unknown[];
  readonly actionBlock: string;
  readonly matchedActions: readonly unknown[];
  readonly episodeBlock: string;
  readonly episodeHits: readonly { readonly score: number }[];
  readonly feedBlock: string;
  readonly feedHeadlines: readonly unknown[];
  readonly browsingBlock: string;
  readonly browsingHits: readonly unknown[];
  readonly reflectionBlock: string;
  readonly reflectionLines: readonly unknown[];
}): string {
  const {
    personaTemplatePreamble, personaPrompt, withTools, notesFraming, contextBlock,
    taskBlock, openTasks, calendarBlock, upcomingEvents, reminderBlock, pendingReminders,
    contactBlock, matchedContacts, memoryBlock, matchedMemories, shellBlock, matchedCommands,
    gitBlock, matchedCommits, actionBlock, matchedActions, episodeBlock, episodeHits,
    feedBlock, feedHeadlines, browsingBlock, browsingHits, reflectionBlock, reflectionLines
  } = params;

  return [
        ...(personaTemplatePreamble.length > 0 ? [personaTemplatePreamble, ""] : []),
        ...(personaPrompt ? [personaPrompt, ""] : []),
        composeSurfacePrompt("ask", {}),
        // The chat-only path is context-locked; the --with-tools path must NOT
        // be, or the lock wins over the armed tools and the model never calls
        // them (observed live: browser_open 0 calls under the ONLY phrasing).
        ...(withTools === true
          ? [
              "Answer the user's question from the context provided below, plus your TOOLS when the context is not enough.",
              "When the user asks to open / read / act on a web page or live resource the context below does not contain, CALL the matching tool (e.g. browser_open for a URL) instead of refusing or answering from memory.",
              // Agentic persistence — without this the local model stops after the
              // first tool call (ran a test, saw it fail, then quit) or answers
              // short instead of acting. Lifts the edit→run→verify loop 1/3 → 3/3
              // (eval:edit-run-verify). Conditional ("when a task needs several
              // steps") so a single-tool ask is unaffected.
              "When a task needs several steps (e.g. read a file, change it, run a command), keep taking the next action after each tool result until it is actually done — do not stop after a single tool call.",
              "If a command or test you run reports a failure, find the cause, fix it with your tools, and run it again to confirm it passes before you answer.",
              "If neither the provided context nor a tool result contains enough information, say so directly — do not invent facts."
            ]
          : [
              "Answer the user's question USING ONLY the notes, open tasks, upcoming events, pending reminders, matching contacts, past session summaries, recent feed headlines, and pages you've visited provided below as context.",
              "If none of the provided context contains enough information, say so directly — do not invent facts."
            ]),
        "Reply in the user's preferred language (from persona prefs).",
        "Keep it concise — 2–4 sentences unless the question explicitly needs more.",
        "Do NOT include the raw '<<note N — ...>>' / '<<task N>>' / '<<event N>>' / '<<reminder N>>' wrapper markers in your answer; speak naturally.",
        // A small local model (qwen3:8b) PARROTS a concrete example
        // citation verbatim — earlier this prompt showed
        // `[from journal/2026-05-12.md]` / `[feed: Hacker News]` as
        // examples and the model cited those exact fake sources
        // regardless of the real corpus, fabricating the one thing the
        // wedge promises is verifiable. So: NO concrete example values.
        // Anchor every citation to the marker of the passage actually
        // used, use ALL-CAPS placeholders (explicitly "never output the
        // placeholder word"), and hard-forbid citing any source not
        // shown in a marker below.
        ...CITATION_INSTRUCTION_LINES,
        // The reasoning-principles block is on by default; MUSE_ASK_REASONING_PRINCIPLES=0
        // disables it — the flag is the A/B seam for measuring whether the principles
        // actually improve answers.
        ...(process.env.MUSE_ASK_REASONING_PRINCIPLES === "0" ? [] : REASONING_PRINCIPLE_LINES),
        "",
        // Volatile lines live BELOW the stable instruction block so the long
        // static prefix stays byte-identical across turns — Ollama reuses the
        // KV cache for a shared prompt prefix, and a time string near the top
        // was breaking that reuse on every turn. The date/time line itself is
        // still ALWAYS present ("anything due today?" needs `now`); when a
        // persona is injected it duplicates buildMusePersona's line — harmless.
        ...(notesFraming.guidance ? [notesFraming.guidance] : []),
        // Persona already carries its own date/time line (buildMusePersona);
        // only the persona-less path needs this one — the duplicate was ~20
        // wasted tokens every persona turn (subtraction sweep).
        ...(personaPrompt ? [] : [formatCurrentContextLine()]),
        "",
        notesFraming.header,
        contextBlock,
        "=== END NOTES ===",
        "",
        // Optional sources: each is included ONLY when it has content this turn —
        // an empty block bloats the small model's prompt and invites a spurious
        // "[reminder: none]"-style citation. (Notes above is always present.)
        ...groundingSectionLines(optionalGroundingSections({
          tasks: { body: taskBlock, present: openTasks.length > 0 },
          calendar: { body: calendarBlock, present: upcomingEvents.length > 0 },
          reminders: { body: reminderBlock, present: pendingReminders.length > 0 },
          contacts: { body: contactBlock, present: matchedContacts.length > 0 },
          memories: { body: memoryBlock, present: matchedMemories.length > 0 },
          shell: { body: shellBlock, present: matchedCommands.length > 0 },
          git: { body: gitBlock, present: matchedCommits.length > 0 },
          actions: { body: actionBlock, present: matchedActions.length > 0 },
          episodes: {
            body: episodeBlock,
            present: episodeHits.length > 0,
            relevance: episodeHits.length > 0
              ? optionalGroundingRelevance("episodes", Math.max(...episodeHits.map((e) => e.score)))
              : undefined
          },
          feeds: { body: feedBlock, present: feedHeadlines.length > 0 },
          browsing: { body: browsingBlock, present: browsingHits.length > 0 },
          reflection: { body: reflectionBlock, present: reflectionLines.length > 0 }
        }))
      ].join("\n").trimEnd();
}
