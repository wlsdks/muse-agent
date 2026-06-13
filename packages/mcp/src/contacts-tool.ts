/**
 * `find_contact` agent tool — look up one of the user's contacts by
 * name/alias so a `muse ask` conversation can answer "what's Jane's
 * email?" / "who is Bob?". Read-only; reuses `resolveContact`'s
 * fail-close semantics (an ambiguous name returns the candidates, never
 * a guessed person — the recipient-resolution backbone of
 * outbound-safety). No approval gate (read).
 */

import { createRunId, type JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { resolveContact, resolveUpcomingBirthdays, type Contact } from "./personal-contacts-store.js";

const BIRTHDAY_RE = /^(?:\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;

export interface ContactsFindToolDeps {
  readonly contacts: () => Promise<readonly Contact[]> | readonly Contact[];
}

export function createContactsFindTool(deps: ContactsFindToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Look up one of the user's contacts and return their email / handle / phone / birthday / relationship (their role, e.g. 'doctor'), plus what the user knows about them (about: facts like 'allergic to nuts') and their connections (who they work/relate with). Look up by name or alias, OR reverse-look-up by an identifier — a phone number ('who is +1 415 555 0101?'), an email ('whose email is bob@acme.com?'), or an @handle. Use to get a person's details, identify who a number/email/handle belongs to, or recall what you know about someone. An ambiguous query returns the candidate names (never a guess); an unknown one returns found:false. Read-only.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          name: { description: "Who to look up: a contact name or alias (e.g. 'Bob'), OR an identifier to reverse-look-up — a phone number (e.g. '+1 415 555 0101'), an email (e.g. 'bob@acme.com'), or an @handle (e.g. '@bob').", type: "string" }
        },
        required: ["name"],
        type: "object"
      },
      keywords: ["contact", "email", "address", "who", "whose", "person", "handle", "birthday", "phone", "number", "call", "text", "about", "allergic"],
      name: "find_contact",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const name = typeof args["name"] === "string" ? args["name"].trim() : "";
      if (name.length === 0) {
        return { found: false, reason: "name is required (e.g. Bob)" };
      }
      const resolution = resolveContact(await Promise.resolve(deps.contacts()), name);
      if (resolution.status === "resolved") {
        const c = resolution.contact;
        return {
          found: true,
          name: c.name,
          ...(c.email ? { email: c.email } : {}),
          ...(c.handle ? { handle: c.handle } : {}),
          ...(c.phone ? { phone: c.phone } : {}),
          ...(c.birthday ? { birthday: c.birthday } : {}),
          ...(c.relationship ? { relationship: c.relationship } : {}),
          // `about` (free-text recall material) and `connections` are the
          // contact's "what do I know about this person" content — the tool
          // resolved them but dropped them, so "what is Bob allergic to?" /
          // "who does Bob work with?" couldn't answer from find_contact.
          ...(c.about ? { about: c.about } : {}),
          ...(c.connections && c.connections.length > 0
            ? { connections: c.connections.map((x) => ({ to: x.to, ...(x.as ? { as: x.as } : {}) })) }
            : {})
        };
      }
      if (resolution.status === "ambiguous") {
        return { ambiguous: true, candidates: resolution.matches.map((m) => m.name), found: false };
      }
      return { found: false };
    }
  };
}

export interface ContactsAddToolDeps {
  readonly save: (contact: Contact) => Promise<void>;
  readonly idFactory?: () => string;
  /**
   * Optional reader so a re-add of an EXISTING name UPDATES in place (reuses the
   * contact's id + merges fields) instead of creating a duplicate — the tool's
   * description promises "Add (or update)", and a duplicate makes the name resolve
   * ambiguous FOREVER (breaking outbound-safety recipient resolution). Needs an
   * id-idempotent `save` (the store's `addContact`) for the reuse to actually replace.
   */
  readonly contacts?: () => Promise<readonly Contact[]> | readonly Contact[];
}

export function createContactsAddTool(deps: ContactsAddToolDeps): MuseTool {
  const idFactory = deps.idFactory ?? (() => createRunId("contact"));
  return {
    definition: {
      description:
        "Add (or update) a person in the user's contacts so they can be found, emailed, or called later. Use when the user gives you someone's details to remember ('save Bob, bob@x.com' / 'mom's number is 415-555-0101' / 'add Dr. Park, she's my dentist'). Requires a name and at least one of email / handle / phone. When the user states how the person relates to them ('my manager', 'my doctor', 'my wife'), record it in `relationship` — it is what later answers 'who is my manager?'. A local store write — not a message to anyone.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          birthday: { description: "Optional birthday as MM-DD or YYYY-MM-DD, e.g. '12-25'.", type: "string" },
          email: { description: "Email address, e.g. 'bob@acme.com'.", type: "string" },
          handle: { description: "Chat handle, e.g. '@bob'.", type: "string" },
          name: { description: "The person's name, e.g. 'Bob Acme'.", type: "string" },
          phone: { description: "Phone number, e.g. '+1 415 555 0101' or '415-555-0101'.", type: "string" },
          relationship: { description: "How this person relates to the user — their role, e.g. 'doctor', 'manager', 'wife', 'landlord', 'dentist'. Set this whenever the user says 'my <role>'; it powers later 'who is my <role>?' lookups.", type: "string" }
        },
        required: ["name"],
        type: "object"
      },
      groundedArgs: ["relationship"],
      keywords: ["contact", "add", "save", "remember", "person", "phone", "number"],
      name: "add_contact",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const name = typeof args["name"] === "string" ? args["name"].trim() : "";
      const email = typeof args["email"] === "string" ? args["email"].trim() : "";
      const handle = typeof args["handle"] === "string" ? args["handle"].trim() : "";
      const phone = typeof args["phone"] === "string" ? args["phone"].trim() : "";
      const birthday = typeof args["birthday"] === "string" ? args["birthday"].trim() : "";
      const relationship = typeof args["relationship"] === "string" ? args["relationship"].trim() : "";
      if (name.length === 0) {
        return { added: false, reason: "name is required" };
      }
      if (email.length === 0 && handle.length === 0 && phone.length === 0) {
        return { added: false, reason: "provide at least one of email / handle / phone so the contact can be reached" };
      }
      if (birthday.length > 0 && !BIRTHDAY_RE.test(birthday)) {
        return { added: false, reason: `birthday must be MM-DD or YYYY-MM-DD (got '${birthday}')` };
      }
      // Re-add of an existing name UPDATES in place: reuse the id (so an id-idempotent
      // save replaces, not appends) and merge — a newly-given field wins, an unmentioned
      // one is preserved. Without this the "(or update)" path silently duplicated, after
      // which the name resolved ambiguous forever.
      const existing = deps.contacts
        ? (await deps.contacts()).find((c) => c.name.trim().toLowerCase() === name.toLowerCase())
        : undefined;
      const keep = (value: string, prior: string | undefined): { value: string } | undefined =>
        value.length > 0 ? { value } : prior ? { value: prior } : undefined;
      const merged = {
        birthday: keep(birthday, existing?.birthday),
        email: keep(email, existing?.email),
        handle: keep(handle, existing?.handle),
        phone: keep(phone, existing?.phone),
        relationship: keep(relationship, existing?.relationship)
      };
      const contact: Contact = {
        id: existing?.id ?? idFactory(),
        name,
        ...(merged.email ? { email: merged.email.value } : {}),
        ...(merged.handle ? { handle: merged.handle.value } : {}),
        ...(merged.phone ? { phone: merged.phone.value } : {}),
        ...(merged.birthday ? { birthday: merged.birthday.value } : {}),
        ...(merged.relationship ? { relationship: merged.relationship.value } : {})
      };
      await deps.save(contact);
      return { added: true, id: contact.id, name: contact.name, ...(existing ? { updated: true } : {}), ...(relationship.length > 0 ? { relationship } : {}) };
    }
  };
}

export interface UpcomingBirthdaysToolDeps {
  readonly contacts: () => Promise<readonly Contact[]> | readonly Contact[];
  /** Injected clock so the look-ahead window is deterministic in tests. */
  readonly now?: () => Date;
}

export function createUpcomingBirthdaysTool(deps: UpcomingBirthdaysToolDeps): MuseTool {
  return {
    definition: {
      description:
        "List the user's contacts whose birthday falls within the next N days (default 30), soonest first — answers 'whose birthday is coming up?' / '이번 주 생일인 사람 있어?'. Use when the user asks which people have upcoming birthdays WITHOUT naming a specific person. Do NOT use to look up ONE named person's birthday ('when is Bob's birthday?') — use find_contact for that. Read-only.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          withinDays: { description: "Look-ahead window in days, e.g. 7 for 'this week'. Defaults to 30.", maximum: 365, minimum: 1, type: "integer" }
        },
        required: [],
        type: "object"
      },
      keywords: ["birthday", "birthdays", "upcoming", "생일", "coming up", "this week", "anniversary"],
      name: "upcoming_birthdays",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const raw = args["withinDays"];
      const withinDays = typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.min(365, Math.trunc(raw)) : 30;
      const contacts = await Promise.resolve(deps.contacts());
      const now = deps.now ? deps.now() : new Date();
      const upcoming = resolveUpcomingBirthdays(contacts, { now, withinDays });
      return {
        count: upcoming.length,
        upcoming: upcoming.map((u) => ({ date: u.date, daysUntil: u.daysUntil, name: u.contact.name })),
        withinDays
      };
    }
  };
}

export interface ContactsRemoveToolDeps {
  readonly contacts: () => Promise<readonly Contact[]> | readonly Contact[];
  readonly remove: (id: string) => Promise<boolean>;
}

export function createContactsRemoveTool(deps: ContactsRemoveToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Remove a person from the user's contacts by name or alias. Use when the user asks to delete / forget a contact. An ambiguous name returns the candidate names (never removes a guess); an unknown name returns removed:false. A local store write.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          name: { description: "Contact name or alias to remove, e.g. 'Bob' or 'Jane Doe'.", type: "string" }
        },
        required: ["name"],
        type: "object"
      },
      keywords: ["contact", "remove", "delete", "forget", "person"],
      name: "remove_contact",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const name = typeof args["name"] === "string" ? args["name"].trim() : "";
      if (name.length === 0) {
        return { removed: false, reason: "name is required" };
      }
      const resolution = resolveContact(await Promise.resolve(deps.contacts()), name);
      if (resolution.status === "ambiguous") {
        return { ambiguous: true, candidates: resolution.matches.map((m) => m.name), removed: false };
      }
      if (resolution.status !== "resolved") {
        return { removed: false };
      }
      const ok = await deps.remove(resolution.contact.id);
      return ok ? { name: resolution.contact.name, removed: true } : { removed: false };
    }
  };
}
