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
import { addContact, contactIdentifier, queryContacts, resolveContact, resolveUpcomingBirthdays, type Contact } from "@muse/mcp";
import { createRunId } from "@muse/shared";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

function contactsFile(): string {
  return resolveContactsFile(process.env as Record<string, string | undefined>);
}

function describeContact(contact: Contact): string {
  const aliases = contact.aliases && contact.aliases.length > 0 ? ` (aka ${contact.aliases.join(", ")})` : "";
  const reach = [contactIdentifier(contact), contact.phone]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" · ");
  return `${contact.name}${aliases}${reach ? ` — ${reach}` : " — (no email/handle/phone)"}`;
}

interface AddOptions {
  readonly email?: string;
  readonly handle?: string;
  readonly phone?: string;
  readonly alias?: readonly string[];
  readonly birthday?: string;
}

const BIRTHDAY_RE = /^(?:\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;

export function registerContactsCommands(program: Command, io: ProgramIO): void {
  const contacts = program.command("contacts").description("Manage and resolve your people graph (~/.muse/contacts.json)");

  contacts
    .command("add")
    .description("Add (or replace) a contact")
    .argument("<name...>", "Contact name")
    .option("--email <email>", "Email address")
    .option("--handle <handle>", "Chat handle (e.g. @alice)")
    .option("--phone <phone>", "Phone number (e.g. +1 415 555 0101)")
    .option("--alias <alias...>", "Alternate names this contact resolves from")
    .option("--birthday <date>", "Birthday as MM-DD or YYYY-MM-DD (for `muse contacts birthdays`)")
    .action(async (nameParts: readonly string[], options: AddOptions) => {
      const name = nameParts.join(" ").trim();
      if (name.length === 0) {
        io.stderr("usage: muse contacts add <name> [--email <e>] [--handle <h>] [--phone <p>] [--alias <a...>] [--birthday <MM-DD>]\n");
        process.exitCode = 1;
        return;
      }
      if (!options.email && !options.handle && !options.phone) {
        io.stderr("muse contacts add: provide at least one of --email / --handle / --phone so the contact can be reached.\n");
        process.exitCode = 1;
        return;
      }
      const birthday = options.birthday?.trim();
      if (birthday !== undefined && birthday.length > 0 && !BIRTHDAY_RE.test(birthday)) {
        io.stderr(`muse contacts add: --birthday must be MM-DD or YYYY-MM-DD (got '${birthday}')\n`);
        process.exitCode = 1;
        return;
      }
      const aliases = (options.alias ?? []).map((a) => a.trim()).filter((a) => a.length > 0);
      const contact: Contact = {
        id: createRunId("contact"),
        name,
        ...(options.email ? { email: options.email.trim() } : {}),
        ...(options.handle ? { handle: options.handle.trim() } : {}),
        ...(options.phone ? { phone: options.phone.trim() } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(birthday && birthday.length > 0 ? { birthday } : {})
      };
      await addContact(contactsFile(), contact);
      io.stdout(`Added ${describeContact(contact)}\n`);
    });

  contacts
    .command("import")
    .description("Bulk-import contacts from a vCard (.vcf) file — your exported address book")
    .argument("<file>", "Path to a .vcf file (one or many vCards)")
    .option("--json", "Emit a structured summary instead of a human line")
    .action(async (file: string, options: { readonly json?: boolean }) => {
      const { readFile } = await import("node:fs/promises");
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (cause) {
        io.stderr(`muse contacts import: cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      const { parseVCards } = await import("./vcard.js");
      const cards = parseVCards(text);
      const existing = await queryContacts(contactsFile());
      const seenEmails = new Set(existing.flatMap((c) => (c.email ? [c.email.toLowerCase()] : [])));
      const seenPhones = new Set(existing.flatMap((c) => (c.phone ? [c.phone] : [])));
      let imported = 0;
      let skipped = 0;
      for (const card of cards) {
        const email = card.email?.trim();
        const phone = card.phone?.trim();
        // Reachable = a name plus at least one way to reach them; a
        // vCard with neither email nor phone is a bare label, skip it.
        if (card.name.trim().length === 0 || (!email && !phone)) {
          skipped += 1;
          continue;
        }
        // De-dupe by email OR phone so re-importing the same export
        // doesn't pile up (a phone-only card has no email to key on).
        if ((email && seenEmails.has(email.toLowerCase())) || (phone && seenPhones.has(phone))) {
          skipped += 1;
          continue;
        }
        const birthday = card.birthday && BIRTHDAY_RE.test(card.birthday) ? card.birthday : undefined;
        const aliases = (card.aliases ?? []).map((a) => a.trim()).filter((a) => a.length > 0);
        const contact: Contact = {
          id: createRunId("contact"),
          name: card.name.trim(),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(aliases.length > 0 ? { aliases } : {}),
          ...(birthday ? { birthday } : {})
        };
        await addContact(contactsFile(), contact);
        if (email) {
          seenEmails.add(email.toLowerCase());
        }
        if (phone) {
          seenPhones.add(phone);
        }
        imported += 1;
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ imported, skipped, total: cards.length })}\n`);
        return;
      }
      io.stdout(`Imported ${imported.toString()} contact${imported === 1 ? "" : "s"} from ${file}${skipped > 0 ? ` (skipped ${skipped.toString()} without a name+email/phone or already present)` : ""}\n`);
    });

  contacts
    .command("export")
    .description("Export your contacts to a vCard (.vcf) — backup or move them to another app")
    .argument("[file]", "Write the vCard to this path (omit to print to stdout)")
    .action(async (file: string | undefined, _options: Record<string, never>) => {
      const all = await queryContacts(contactsFile());
      const { contactsToVcf } = await import("./vcard.js");
      const vcf = contactsToVcf(all);
      const target = file?.trim();
      if (!target) {
        io.stdout(vcf.length > 0 ? vcf : "(no contacts to export)\n");
        return;
      }
      const { writeFile } = await import("node:fs/promises");
      try {
        await writeFile(target, vcf, "utf8");
      } catch (cause) {
        io.stderr(`muse contacts export: cannot write ${target}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      io.stdout(`Exported ${all.length.toString()} contact${all.length === 1 ? "" : "s"} to ${target}\n`);
    });

  contacts
    .command("birthdays")
    .description("Upcoming birthdays, soonest first")
    .option("--within <days>", "Look-ahead window in days (default 30)")
    .action(async (options: { within?: string }) => {
      const withinRaw = options.within !== undefined ? Number(options.within) : undefined;
      const within = withinRaw !== undefined && Number.isFinite(withinRaw) ? withinRaw : 30;
      const upcoming = resolveUpcomingBirthdays(await queryContacts(contactsFile()), { withinDays: within });
      if (upcoming.length === 0) {
        io.stdout(`No birthdays in the next ${within.toString()} days. Set one with \`muse contacts add <name> --email <e> --birthday MM-DD\`.\n`);
        return;
      }
      for (const { contact, daysUntil, date } of upcoming) {
        const when = daysUntil === 0 ? "today" : daysUntil === 1 ? "tomorrow" : `in ${daysUntil.toString()} days`;
        io.stdout(`🎂 ${contact.name} — ${when} (${date})\n`);
      }
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
