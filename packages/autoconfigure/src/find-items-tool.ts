/**
 * `find_items` agent tool + the pure `findAcrossDomains` sweep behind it.
 *
 * One keyword sweep across the user's STRUCTURED local stores — tasks,
 * reminders, contacts, and calendar events — so "where did I mention the
 * dentist?" has a single answer. The sweep already shipped as the `muse find`
 * CLI command, but was never projected as an agent tool: the local model had to
 * chain tasks.list + reminders.list + calendar.list + find_contact and intersect
 * them by keyword itself (4 calls), which it does unreliably (coherence degrades
 * after 2-3 steps). This closes that asymmetry on a NON-temporal axis.
 *
 * Distinct from `find_contact` (a PERSON by name/phone → one contact), the web
 * search tool (the public internet), and notes/recall (note bodies + semantic
 * memory). This stitches the tracked-ITEM stores together by a topic term.
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

export type FindDomain = "task" | "reminder" | "contact" | "event";

export interface FindHit {
  readonly domain: FindDomain;
  readonly id: string;
  readonly label: string;
  /** The matched secondary field, shown when it isn't the label itself. */
  readonly context?: string;
}

export interface FindSources {
  readonly tasks?: readonly { readonly id: string; readonly title?: string; readonly notes?: string }[];
  readonly reminders?: readonly { readonly id: string; readonly text?: string }[];
  readonly contacts?: readonly {
    readonly id: string;
    readonly name?: string;
    readonly email?: string;
    readonly handle?: string;
    readonly phone?: string;
    readonly aliases?: readonly string[];
    readonly relationship?: string;
    readonly about?: string;
  }[];
  readonly events?: readonly { readonly id: string; readonly title?: string; readonly notes?: string }[];
}

/**
 * Pure substring match (case-insensitive) over the structured stores. A blank
 * query matches nothing (a `find` with no term is a usage error, not "match
 * everything"). Contacts match on name/email/handle/phone/alias/relationship/about.
 */
export function findAcrossDomains(sources: FindSources, query: string): readonly FindHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const has = (value: unknown): boolean => typeof value === "string" && value.toLowerCase().includes(q);
  const hits: FindHit[] = [];
  for (const task of sources.tasks ?? []) {
    if (has(task.title) || has(task.notes)) {
      hits.push({
        domain: "task",
        id: task.id,
        label: task.title ?? "(untitled)",
        ...(has(task.notes) && !has(task.title) ? { context: task.notes } : {})
      });
    }
  }
  for (const reminder of sources.reminders ?? []) {
    if (has(reminder.text)) hits.push({ domain: "reminder", id: reminder.id, label: reminder.text ?? "" });
  }
  for (const contact of sources.contacts ?? []) {
    const aliasHit = (contact.aliases ?? []).some((alias) => has(alias));
    const idHit = has(contact.name) || has(contact.email) || has(contact.handle) || has(contact.phone) || aliasHit;
    const relHit = has(contact.relationship);
    const aboutHit = has(contact.about);
    if (idHit || relHit || aboutHit) {
      const context = idHit ? undefined : aboutHit ? contact.about : relHit ? `your ${contact.relationship!}` : undefined;
      hits.push({ domain: "contact", id: contact.id, label: contact.name ?? "", ...(context ? { context } : {}) });
    }
  }
  for (const event of sources.events ?? []) {
    if (has(event.title) || has(event.notes)) {
      hits.push({
        domain: "event",
        id: event.id,
        label: event.title ?? "(untitled)",
        ...(has(event.notes) && !has(event.title) ? { context: event.notes } : {})
      });
    }
  }
  return hits;
}

export interface FindItemsToolDeps {
  readonly find: () => Promise<FindSources> | FindSources;
}

export function createFindItemsTool(deps: FindItemsToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Searches your OWN tracked items — tasks, reminders, contacts, and calendar events — for everything that mentions a word or topic, in ONE call. Answers 'where did I mention the dentist?' / 'find anything about the Berlin trip' / '어디서 치과 얘기 했었지?' / '내 할 일이랑 일정에서 X 들어간 거 다 찾아줘'. USE WHEN the user wants to locate a TOPIC/keyword across their tracked stuff. Do NOT use for: looking up a PERSON by name/phone/email (use find_contact); searching the public web (use the web search tool); searching note bodies or memory (use notes/recall).",
      domain: "knowledge",
      inputSchema: {
        additionalProperties: false,
        properties: {
          query: { description: "The word or topic to look for across tasks/reminders/contacts/events, e.g. 'dentist' or 'Berlin trip'.", type: "string" }
        },
        required: ["query"],
        type: "object"
      },
      keywords: ["find", "search my", "where did i mention", "anything about", "어디서", "찾아", "언급", "내 거에서", "across", "mentioned"],
      name: "find_items",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const query = typeof args["query"] === "string" ? args["query"] : "";
      const hits = findAcrossDomains(await Promise.resolve(deps.find()), query);
      return { hits: hits.map((h) => ({ ...h })), total: hits.length };
    }
  };
}
