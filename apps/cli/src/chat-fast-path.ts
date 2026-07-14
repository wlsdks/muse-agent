/**
 * Deterministic fast-path dispatcher for `muse chat` — extracted from
 * `runLocalChat` so the god-function reads as setup → fast-path → grounding →
 * persistence. Each branch short-circuits BEFORE any model call because the
 * local 8B is unreliable on these (mis-multiplies arithmetic, off-by-days on
 * calendar math, over-claims meta, won't list tasks/reminders/contacts). Every
 * branch returns the uniform `{ response, runId, toolsUsed: [] }`; a miss returns
 * `undefined` so the caller falls through to grounded recall. Behavior is
 * identical to the inline chain it replaced — same order, same detectors.
 */

import { classifyContactLookup, classifyCorpusOverview, classifyMetaPrompt, classifyReminderListQuery, classifyTaskListQuery } from "@muse/agent-core";
import { resolveNotesDir } from "@muse/autoconfigure";
import { describeCapabilities } from "@muse/prompts";

import { detectArithmeticQuery, formatArithmeticResult } from "./arithmetic-query.js";
import { countdownDays, detectCountdownQuery, formatCountdown } from "./countdown-query.js";
import { detectDateQuery, formatDateAnswer, phraseHasTime } from "./date-query.js";
import { detectDateDiffQuery, formatDateDiff } from "./date-diff-query.js";
import { detectTimezoneQuery, formatTimezone } from "./timezone-query.js";
import { formatContactDetails, formatNotesOverview, formatReminderList, formatTaskList } from "./chat-fast-path-format.js";

export interface ChatFastPathResult {
  readonly response: string;
  readonly runId: string;
  readonly toolsUsed: readonly string[];
}

/**
 * Try every deterministic short-circuit in order; return the first hit or
 * `undefined`. `message` must already be NFC-normalized by the caller.
 */
export async function resolveChatFastPath(message: string): Promise<ChatFastPathResult | undefined> {
  // A question ABOUT Muse itself short-circuits to a deterministic, honest
  // capability answer BEFORE any model call — the local model otherwise
  // over-claims and (observed) injects an unrelated note into the reply.
  if (classifyMetaPrompt(message)) {
    // Env-aware at call time (process.env) so the answer reflects which
    // integrations are actually armed — "Email: connected" only when the token
    // is set, "available — set X" otherwise. Never over-claims a capability the
    // user hasn't configured.
    return {
      response: describeCapabilities(process.env, /[가-힣]/u.test(message)),
      runId: "local-meta",
      toolsUsed: []
    };
  }

  // "내 노트 뭐 있어?" / "what notes do I have" wants the INVENTORY, but top-K
  // recall ranks the whole corpus weakly so the model refused or dumped raw
  // "ref=…" ids. List it deterministically when the user actually has notes.
  if (classifyCorpusOverview(message)) {
    // Lazy import: a STATIC import of the big `commands-ask` module pulls its
    // async-init dependency graph into chat-repl's module init, which the bun
    // `--compile` bundler emits as a top-level `await init_commands_ask()` in a
    // sync context → the bundled desktop binary crashes at startup. Defer it.
    const { listNoteFiles, notesCorpusFileCount } = await import("./commands-ask.js");
    const notesDir = resolveNotesDir(process.env);
    const total = await notesCorpusFileCount(notesDir).catch(() => 0);
    if (total > 0) {
      return {
        response: formatNotesOverview(await listNoteFiles(notesDir), total, /[가-힣]/u.test(message)),
        runId: "local-corpus",
        toolsUsed: []
      };
    }
  }

  // "내 할일 뭐 있어?" — the to-do LIST intent. qwen3:8b reads the possessive
  // "뭐 있어" as a memory question and won't call tasks.list (it DOES for the
  // identical "내 일정 뭐 있어?" → calendar.list), so without this the recall gate
  // wrongly abstains "그건 아직 기억하고 있지 않아요" while open tasks sit on disk.
  // List them deterministically — same remedy as the notes corpus overview above.
  if (classifyTaskListQuery(message)) {
    const { formatDueLocal } = await import("@muse/mcp-shared");
    const { readTasks, compareTasksByDueDate } = await import("@muse/stores");
    const { resolveTasksFile } = await import("@muse/autoconfigure");
    const tasksFile = resolveTasksFile(process.env);
    const open = (await readTasks(tasksFile).catch(() => []))
      .filter((task) => task.status === "open")
      .sort(compareTasksByDueDate);
    return {
      response: formatTaskList(
        open.map((task) => ({
          title: task.title,
          ...(task.dueAt ? { dueLocal: formatDueLocal(task.dueAt) } : {}),
          ...(task.urgent ? { urgent: true } : {})
        })),
        /[가-힣]/u.test(message)
      ),
      runId: "local-tasks",
      toolsUsed: []
    };
  }

  // "리마인더 뭐 있어?" — the reminder LIST intent, the exact sibling of the
  // task-list case above (the 8B reads "뭐 있어" as a memory question and won't
  // call reminders.list, so the recall gate wrongly abstains "없습니다" while
  // pending reminders sit on disk). List the pending ones deterministically.
  if (classifyReminderListQuery(message)) {
    const { formatDueLocal } = await import("@muse/mcp-shared");
    const { readReminders } = await import("@muse/stores");
    const { resolveRemindersFile } = await import("@muse/autoconfigure");
    const remindersFile = resolveRemindersFile(process.env);
    const pending = (await readReminders(remindersFile).catch(() => []))
      .filter((reminder) => reminder.status === "pending")
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return {
      response: formatReminderList(
        pending.map((reminder) => ({ dueLocal: formatDueLocal(reminder.dueAt), overdue: new Date(reminder.dueAt).getTime() < Date.now(), text: reminder.text })),
        /[가-힣]/u.test(message)
      ),
      runId: "local-reminders",
      toolsUsed: []
    };
  }

  // "박지훈 전화번호 알려줘" — a contact-detail lookup. The 8B won't call
  // find_contact for these (it abstains, even claiming it has no contact feature),
  // so resolve the named contact deterministically. resolveContact is the
  // precision gate: an unknown name (or a non-contact phrase) falls through to the
  // normal path instead of short-circuiting.
  const contactName = classifyContactLookup(message);
  if (contactName) {
    const { queryContacts, resolveContact } = await import("@muse/stores");
    const { resolveContactsFile } = await import("@muse/autoconfigure");
    const contacts = await queryContacts(resolveContactsFile(process.env)).catch(() => []);
    const resolution = resolveContact(contacts, contactName);
    const korean = /[가-힣]/u.test(message);
    if (resolution.status === "resolved") {
      return { response: formatContactDetails(resolution.contact, korean), runId: "local-contact", toolsUsed: [] };
    }
    if (resolution.status === "ambiguous") {
      const names = resolution.matches.map((contact) => contact.name).join(", ");
      return {
        response: korean ? `여러 명이 있어요: ${names}. 누구를 말씀하시는 건가요?` : `Several match: ${names}. Which one?`,
        runId: "local-contact",
        toolsUsed: []
      };
    }
    // status "unknown" → not a known contact; fall through to the normal path.
  }

  // Pure arithmetic ("12 times 4", "what is (1200+850)/2") — the local 8B
  // confidently mis-multiplies ("12 times 4" → "24"), so compute it
  // deterministically through the same evaluator the muse.math tool uses rather
  // than trusting the model's digits. The precision-first detector only fires on
  // a query that is NOTHING but a calculation, so a notes question is untouched.
  const arithmeticExpression = detectArithmeticQuery(message);
  if (arithmeticExpression) {
    const { evaluateArithmeticExpression } = await import("@muse/mcp");
    const evaluated = evaluateArithmeticExpression(arithmeticExpression);
    if ("result" in evaluated) {
      return {
        response: formatArithmeticResult(arithmeticExpression, evaluated.result),
        runId: "local-arithmetic",
        toolsUsed: []
      };
    }
  }

  // Sibling deterministic compute fast-paths — the 8B is confidently off-by-days
  // on calendar math (it answered "189 days" and "209 days" for counts whose
  // exact values are 201 and 217). Count those EXACTLY from the host clock, same
  // as the arithmetic path. Each detector is precision-first (falls through to
  // grounded recall unless the query is NOTHING but that computation).
  {
    const datePhrase = detectDateQuery(message);
    if (datePhrase !== null) {
      const { parseReminderDueAt } = await import("@muse/stores");
      const resolved = parseReminderDueAt(datePhrase, () => new Date());
      if (!(resolved instanceof Error)) {
        return {
          response: formatDateAnswer(datePhrase, resolved, { includeTime: phraseHasTime(datePhrase) }),
          runId: "local-date",
          toolsUsed: []
        };
      }
    }
    const countdown = detectCountdownQuery(message);
    if (countdown) {
      const { parseReminderDueAt } = await import("@muse/stores");
      const now = new Date();
      const resolved = parseReminderDueAt(countdown.targetPhrase, () => now);
      if (!(resolved instanceof Error)) {
        const days = countdownDays(now, resolved);
        if (days >= 0) {
          return { response: formatCountdown(countdown.unit, days, resolved, countdown.ko), runId: "local-countdown", toolsUsed: [] };
        }
      }
    }
    const dateDiff = detectDateDiffQuery(message, new Date());
    if (dateDiff) {
      return { response: formatDateDiff(dateDiff), runId: "local-date-diff", toolsUsed: [] };
    }
    // Time-zone conversion / "what time is it in X" — the 8B doesn't reliably know
    // offsets or DST (it answered "5am"/"6am" for 3pm New York → Seoul, exact: 4am
    // EDT). formatTimezone computes it DST-correctly from the IANA database.
    const timezone = detectTimezoneQuery(message);
    if (timezone) {
      return { response: formatTimezone(timezone, new Date()), runId: "local-timezone", toolsUsed: [] };
    }
  }

  return undefined;
}
