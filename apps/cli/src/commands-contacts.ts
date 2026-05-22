/**
 * `muse contacts` — the user's people graph (`~/.muse/contacts.json`).
 * Add / list / resolve a name → identifier. Resolution is the
 * recipient-resolution backbone for outbound safety: `resolve` reports
 * an AMBIGUOUS / not-found result rather than guessing a recipient, so
 * a downstream "email Bob" never mails the wrong person.
 *
 * Read/write of the local store only — no third-party action, so no
 * outbound-safety approval gate applies here.
 */

import { resolveContactsFile } from "@muse/autoconfigure";
import { addContact, contactIdentifier, queryContacts, resolveContact, type Contact } from "@muse/mcp";
import { createRunId } from "@muse/shared";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

function contactsFile(): string {
  return resolveContactsFile(process.env as Record<string, string | undefined>);
}

function describeContact(contact: Contact): string {
  const id = contactIdentifier(contact);
  const aliases = contact.aliases && contact.aliases.length > 0 ? ` (aka ${contact.aliases.join(", ")})` : "";
  return `${contact.name}${aliases}${id ? ` — ${id}` : " — (no email/handle)"}`;
}

interface AddOptions {
  readonly email?: string;
  readonly handle?: string;
  readonly alias?: readonly string[];
}

export function registerContactsCommands(program: Command, io: ProgramIO): void {
  const contacts = program.command("contacts").description("Manage and resolve your people graph (~/.muse/contacts.json)");

  contacts
    .command("add")
    .description("Add (or replace) a contact")
    .argument("<name...>", "Contact name")
    .option("--email <email>", "Email address")
    .option("--handle <handle>", "Chat handle (e.g. @alice)")
    .option("--alias <alias...>", "Alternate names this contact resolves from")
    .action(async (nameParts: readonly string[], options: AddOptions) => {
      const name = nameParts.join(" ").trim();
      if (name.length === 0) {
        io.stderr("usage: muse contacts add <name> [--email <e>] [--handle <h>] [--alias <a...>]\n");
        process.exitCode = 1;
        return;
      }
      if (!options.email && !options.handle) {
        io.stderr("muse contacts add: provide at least one of --email / --handle so the contact can be resolved to a recipient.\n");
        process.exitCode = 1;
        return;
      }
      const aliases = (options.alias ?? []).map((a) => a.trim()).filter((a) => a.length > 0);
      const contact: Contact = {
        id: createRunId("contact"),
        name,
        ...(options.email ? { email: options.email.trim() } : {}),
        ...(options.handle ? { handle: options.handle.trim() } : {}),
        ...(aliases.length > 0 ? { aliases } : {})
      };
      await addContact(contactsFile(), contact);
      io.stdout(`Added ${describeContact(contact)}\n`);
    });

  contacts
    .command("list")
    .description("List all contacts (name-sorted)")
    .action(async () => {
      const all = await queryContacts(contactsFile());
      if (all.length === 0) {
        io.stdout("No contacts yet. Add one with `muse contacts add <name> --email <e>`.\n");
        return;
      }
      for (const contact of all) {
        io.stdout(`${describeContact(contact)}\n`);
      }
    });

  contacts
    .command("resolve")
    .description("Resolve a name to a recipient — reports AMBIGUOUS / not-found rather than guessing")
    .argument("<name...>", "Name or alias to resolve")
    .action(async (nameParts: readonly string[]) => {
      const query = nameParts.join(" ").trim();
      if (query.length === 0) {
        io.stderr("usage: muse contacts resolve <name>\n");
        process.exitCode = 1;
        return;
      }
      const resolution = resolveContact(await queryContacts(contactsFile()), query);
      if (resolution.status === "resolved") {
        io.stdout(`${describeContact(resolution.contact)}\n`);
        return;
      }
      if (resolution.status === "ambiguous") {
        io.stderr(`'${query}' is ambiguous — did you mean one of:\n`);
        for (const match of resolution.matches) {
          io.stderr(`  - ${describeContact(match)}\n`);
        }
        process.exitCode = 1;
        return;
      }
      io.stderr(`No contact matches '${query}'. Add one with \`muse contacts add\`.\n`);
      process.exitCode = 1;
    });
}
