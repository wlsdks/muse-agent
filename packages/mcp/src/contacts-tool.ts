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

import { resolveContact, type Contact } from "./personal-contacts-store.js";

const BIRTHDAY_RE = /^(?:\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;

export interface ContactsFindToolDeps {
  readonly contacts: () => Promise<readonly Contact[]> | readonly Contact[];
}

export function createContactsFindTool(deps: ContactsFindToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Look up one of the user's contacts by name or alias and return their email / handle / phone / birthday / relationship (their role, e.g. 'doctor'). Use when you need a person's contact details, their phone number, their birthday, their role, or to confirm who someone is. An ambiguous name returns the candidate names (never a guess); an unknown name returns found:false. Read-only.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          name: { description: "Contact name or alias to look up, e.g. 'Bob' or 'Jane Doe'.", type: "string" }
        },
        required: ["name"],
        type: "object"
      },
      keywords: ["contact", "email", "address", "who", "person", "handle", "birthday", "phone", "number", "call", "text"],
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
          ...(c.relationship ? { relationship: c.relationship } : {})
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
      const contact: Contact = {
        id: idFactory(),
        name,
        ...(email.length > 0 ? { email } : {}),
        ...(handle.length > 0 ? { handle } : {}),
        ...(phone.length > 0 ? { phone } : {}),
        ...(birthday.length > 0 ? { birthday } : {}),
        ...(relationship.length > 0 ? { relationship } : {})
      };
      await deps.save(contact);
      return { added: true, id: contact.id, name: contact.name, ...(relationship.length > 0 ? { relationship } : {}) };
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
