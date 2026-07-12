/**
 * Deterministic renderers + constants for the `muse chat` fast-path dispatcher
 * (`chat-fast-path.ts`). Split out of `chat-repl.ts` so the dispatcher and the
 * REPL share one home for these pure formatters without a module cycle. The
 * public ones are re-exported from `chat-repl.ts` to preserve its surface.
 */

import { describeCapabilitiesEn, describeCapabilitiesKo } from "@muse/prompts";

// A question ABOUT Muse ("뭐 할 수 있어?") gets a DETERMINISTIC, honest answer.
// Free-composing on the local model over-claims AND was observed dumping an
// unrelated note (the user's wifi password) into a "what can you do?" reply.
// Sourced from the shared, env-aware capability describer (@muse/prompts) so the
// desktop/chat surface answers identically to `muse ask` and Telegram, and
// legibly covers the whole product (memory, calendar, briefings, actions, chat
// channel, orchestration) rather than the notes-only slice — while still never
// over-claiming an integration that isn't set up. `chat-fast-path.ts` calls the
// describer directly with the live env; these env-neutral constants preserve the
// existing re-export surface.
export const DESKTOP_META_KO = describeCapabilitiesKo({});
export const DESKTOP_META_EN = describeCapabilitiesEn({});

/**
 * Render a notes-corpus inventory for "내 노트 뭐 있어?" / "what notes do I have".
 * Top-K recall ranks every note weakly for a whole-corpus query, so the gate
 * abstains ("I can't list them") — wrong; we DO know the corpus. Deterministic,
 * KO/EN by message script, clean notes-relative paths (no home dir).
 */
export function formatNotesOverview(noteFiles: readonly string[], total: number, korean: boolean): string {
  const lines = noteFiles.map((file) => `  • ${file}`);
  const more = total > noteFiles.length
    ? [korean ? `  … 외 ${(total - noteFiles.length).toString()}개 더` : `  … and ${(total - noteFiles.length).toString()} more`]
    : [];
  const head = korean
    ? `저장된 노트가 ${total.toString()}개 있어요. 이 중 무엇이든 물어보시면 출처와 함께 답해드릴게요:`
    : `You have ${total.toString()} note${total === 1 ? "" : "s"}. Ask me about any of them and I'll quote the source:`;
  return [head, ...lines, ...more].join("\n");
}

/** Render the open-task list for the deterministic "내 할일 뭐 있어?" short-circuit.
 *  `dueLocal` is a pre-rendered LOCAL-time string (never the raw UTC ISO). */
export function formatTaskList(
  tasks: readonly { readonly title: string; readonly dueLocal?: string; readonly urgent?: boolean }[],
  korean: boolean
): string {
  if (tasks.length === 0) {
    return korean ? "지금은 열린 할 일이 없어요." : "You have no open tasks right now.";
  }
  const lines = tasks.map((task) => {
    const due = task.dueLocal ? (korean ? ` — ${task.dueLocal} 마감` : ` — due ${task.dueLocal}`) : "";
    const flag = task.urgent ? "⚡ " : "";
    return `  • ${flag}${task.title}${due}`;
  });
  const head = korean
    ? `열린 할 일이 ${tasks.length.toString()}개 있어요:`
    : `You have ${tasks.length.toString()} open task${tasks.length === 1 ? "" : "s"}:`;
  return [head, ...lines].join("\n");
}

/** A deterministic reminder list for the chat surface (parity with formatTaskList). */
export function formatReminderList(
  reminders: readonly { readonly text: string; readonly dueLocal?: string; readonly overdue?: boolean }[],
  korean: boolean
): string {
  if (reminders.length === 0) {
    return korean ? "지금은 예정된 리마인더가 없어요." : "You have no upcoming reminders right now.";
  }
  const lines = reminders.map((reminder) => {
    const due = reminder.dueLocal ? ` — ${reminder.dueLocal}` : "";
    // Flag a past-due pending reminder so a late item is scannable in-chat too
    // (parity with `muse remind list`'s (⚠ overdue) marker).
    const overdue = reminder.overdue ? (korean ? " (⚠ 지남)" : " (⚠ overdue)") : "";
    return `  • ${reminder.text}${due}${overdue}`;
  });
  const head = korean
    ? `예정된 리마인더가 ${reminders.length.toString()}개 있어요:`
    : `You have ${reminders.length.toString()} upcoming reminder${reminders.length === 1 ? "" : "s"}:`;
  return [head, ...lines].join("\n");
}

/** One contact's known details on a single line — the deterministic answer to a
 *  "<name> 전화번호 / 관계 / 이메일" lookup the 8B fumbles. */
export function formatContactDetails(
  contact: { readonly name: string; readonly phone?: string; readonly email?: string; readonly handle?: string; readonly relationship?: string; readonly birthday?: string },
  korean: boolean
): string {
  const parts: string[] = [];
  if (contact.phone) parts.push(korean ? `전화 ${contact.phone}` : `phone ${contact.phone}`);
  if (contact.email) parts.push(korean ? `이메일 ${contact.email}` : `email ${contact.email}`);
  if (contact.handle) parts.push(korean ? `핸들 ${contact.handle}` : `handle ${contact.handle}`);
  if (contact.relationship) parts.push(korean ? `관계 ${contact.relationship}` : `relationship ${contact.relationship}`);
  if (contact.birthday) parts.push(korean ? `생일 ${contact.birthday}` : `birthday ${contact.birthday}`);
  if (parts.length === 0) {
    return korean ? `${contact.name} 연락처는 있지만 세부 정보가 저장돼 있지 않아요.` : `${contact.name} is saved, but with no details.`;
  }
  return `${contact.name} — ${parts.join(", ")}`;
}
