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

import { overdueContacts, type OverdueContact } from "@muse/agent-core";
import { interactionsFromEvents, resolveContactsFile, resolveLocalCalendarFile, resolveNotesDir } from "@muse/autoconfigure";
import { readLocalEvents } from "./commands-today.js";
import { addContact, contactIdentifier, decryptContactsAtRest, encryptContactsAtRest, isContactsEncrypted, linkContacts, queryContacts, resolveContact, resolveUpcomingBirthdays, type Contact } from "@muse/mcp";

import { relatedByCooccurrence } from "./contact-cooccurrence.js";
import { findDuplicateContacts, formatDuplicateContacts } from "./contact-dupes.js";
import { createRunId } from "@muse/shared";
import type { Command } from "commander";

import { buildContactNetwork, formatContactNetwork } from "./contact-network.js";
import type { ProgramIO } from "./program.js";

function contactsFile(): string {
  return resolveContactsFile(process.env as Record<string, string | undefined>);
}

/** Read every note body from the local notes dir (best-effort; an unreadable note is skipped). */
async function readNoteBodies(dir: string): Promise<string[]> {
  const { LocalDirNotesProvider } = await import("@muse/mcp");
  const provider = new LocalDirNotesProvider({ notesDir: dir });
  const bodies: string[] = [];
  for (const entry of await provider.list()) {
    const read = await provider.read(entry.id);
    if (read?.body) bodies.push(read.body);
  }
  return bodies;
}

function describeContact(contact: Contact): string {
  const aliases = contact.aliases && contact.aliases.length > 0 ? ` (aka ${contact.aliases.join(", ")})` : "";
  const role = contact.relationship ? ` [your ${contact.relationship}]` : "";
  const reach = [contactIdentifier(contact), contact.phone]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" · ");
  const reachLabel = reach ? ` — ${reach}` : contact.relationship ? "" : " — (no email/handle/phone)";
  const edges = contact.connections && contact.connections.length > 0
    ? `\n    ↔ ${contact.connections.map((c) => `${c.as ? `${c.as} ` : "connected to "}${c.to}`).join(", ")}`
    : "";
  const note = contact.about ? `\n    ℹ ${contact.about}` : "";
  return `${contact.name}${aliases}${role}${reachLabel}${edges}${note}`;
}

/**
 * Filter the people graph by a free-text term — a case-insensitive substring
 * over a contact's name, relationship-to-you, email, handle, phone, and aliases
 * — so `muse contacts list --search coworker` answers "who are my coworkers?"
 * without scrolling the whole list. An empty term returns everything (no-op).
 * Pure.
 */
export function filterContactsBySearch(contacts: readonly Contact[], term: string): readonly Contact[] {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) {
    return contacts;
  }
  return contacts.filter((contact) => {
    const fields = [contact.name, contact.relationship, contact.email, contact.handle, contact.phone, contact.about, ...(contact.aliases ?? [])];
    return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(needle));
  });
}

interface AddOptions {
  readonly email?: string;
  readonly handle?: string;
  readonly phone?: string;
  readonly alias?: readonly string[];
  readonly birthday?: string;
  readonly relationship?: string;
  readonly about?: string;
}

const BIRTHDAY_RE = /^(?:\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;

interface CalendarEventLike {
  readonly title?: string;
  readonly notes?: string;
  readonly startsAt?: string;
}

// `interactionsFromEvents` moved to @muse/autoconfigure so the `overdue_contacts`
// agent tool and this command share one implementation; re-exported for callers.
export { interactionsFromEvents };

/** Render the overdue-contacts nudge. Pure + draft-first (nothing is ever sent). */
export function formatOverdue(overdue: readonly OverdueContact[]): string {
  if (overdue.length === 0) {
    return "💬 No one's overdue — you're keeping up with your people.\n";
  }
  const lines = ["💬 People you might reconnect with (from your calendar; nothing is sent):"];
  for (const contact of overdue) {
    lines.push(
      `  • ${contact.name} — you usually connect about every ${Math.round(contact.cadenceDays).toString()}d, ` +
        `last was ~${Math.round(contact.gapDays).toString()}d ago (${contact.overdueRatio.toFixed(1)}× your usual)`
    );
  }
  return `${lines.join("\n")}\n`;
}

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
    .option("--relationship <role>", "How they relate to you, e.g. 'manager', 'wife', 'doctor' — powers \"who is my manager?\" recall")
    .option("--about <text>", "Free-text facts to remember about them, e.g. 'allergic to nuts, met at PyCon 2024' — powers \"what do I know about Bob?\" recall")
    .action(async (nameParts: readonly string[], options: AddOptions) => {
      const name = nameParts.join(" ").trim();
      if (name.length === 0) {
        io.stderr("usage: muse contacts add <name> [--email <e>] [--handle <h>] [--phone <p>] [--alias <a...>] [--birthday <MM-DD>] [--relationship <role>] [--about <text>]\n");
        process.exitCode = 1;
        return;
      }
      if (!options.email && !options.handle && !options.phone && !options.relationship && !options.about) {
        io.stderr("muse contacts add: provide at least one of --email / --handle / --phone (to reach them) or --relationship / --about (to recall them).\n");
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
        ...(birthday && birthday.length > 0 ? { birthday } : {}),
        ...(options.relationship && options.relationship.trim().length > 0 ? { relationship: options.relationship.trim() } : {}),
        ...(options.about && options.about.trim().length > 0 ? { about: options.about.trim() } : {})
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
      let within = 30;
      if (options.within !== undefined) {
        const parsed = Number(options.within.trim());
        if (!Number.isFinite(parsed) || parsed < 1) {
          io.stderr(`muse contacts birthdays: --within must be a positive number of days (got '${options.within}')\n`);
          process.exitCode = 1;
          return;
        }
        within = Math.min(365, Math.trunc(parsed));
      }
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
    .command("dupes")
    .description("Find likely-duplicate contacts — cards sharing an email, phone, handle, or name — so you can clean up your people graph (e.g. after a vCard import). Read-only; deterministic. Use when contacts feel cluttered; not for finding how people relate (that is `muse contacts network`).")
    .option("--json", "Print the structured duplicate pairs")
    .action(async (options: { readonly json?: boolean }) => {
      const all = await queryContacts(contactsFile());
      const pairs = findDuplicateContacts(all);
      if (options.json) {
        io.stdout(`${JSON.stringify({ pairs, total: pairs.length }, null, 2)}\n`);
        return;
      }
      io.stdout(formatDuplicateContacts(pairs));
    });

  contacts
    .command("list")
    .description("List your contacts (name-sorted); --search filters by name / role / email / alias")
    .option("--search <term...>", "Only show contacts matching this term (name, relationship, alias, email, handle, phone), e.g. 'coworker' or 'kim'")
    .action(async (options: { readonly search?: readonly string[] }) => {
      const all = await queryContacts(contactsFile());
      if (all.length === 0) {
        io.stdout("No contacts yet. Add one with `muse contacts add <name> --email <e>`.\n");
        return;
      }
      const term = (options.search ?? []).join(" ").trim();
      const shown = term.length > 0 ? filterContactsBySearch(all, term) : all;
      if (shown.length === 0) {
        io.stdout(`No contacts match '${term}'. (${all.length.toString()} total — run \`muse contacts list\` to see all.)\n`);
        return;
      }
      for (const contact of shown) {
        io.stdout(`${describeContact(contact)}\n`);
      }
    });

  contacts
    .command("overdue")
    .description("People you haven't connected with in longer than your usual cadence (from calendar timestamps; draft-first, nothing is sent)")
    .option("--json", "Print the raw overdue list")
    .action(async (options: { readonly json?: boolean }) => {
      const all = await queryContacts(contactsFile());
      if (all.length === 0) {
        io.stdout("No contacts yet. Add one with `muse contacts add <name>`.\n");
        return;
      }
      let events: CalendarEventLike[] = [];
      try {
        // Read via the calendar PROVIDER (same path as the evening recap's
        // reconnect section) — so the two never diverge, and a recurring event
        // (a weekly standup with Bob) is expanded into its instances, giving a
        // real interaction history instead of a single stored row.
        const provided = await readLocalEvents(resolveLocalCalendarFile(process.env as Record<string, string | undefined>), new Date(0), new Date());
        events = provided.map((event) => ({ startsAt: event.startsAtIso, title: event.title }));
      } catch {
        // no local calendar → no interaction history → nothing overdue
      }
      const overdue = overdueContacts(interactionsFromEvents(all, events), { nowMs: Date.now() });
      if (options.json) {
        io.stdout(`${JSON.stringify(overdue, null, 2)}\n`);
        return;
      }
      io.stdout(formatOverdue(overdue));
    });

  contacts
    .command("link")
    .description("Record that two people are connected — e.g. `muse contacts link Bob Alice --as 'works with'` → \"who works with Bob?\"")
    .argument("<personA>", "First person's name (or alias)")
    .argument("<personB>", "Second person's name (or alias)")
    .option("--as <relation>", "How they're connected, e.g. 'works with', 'friends with', 'married to' (symmetric)")
    .action(async (personA: string, personB: string, options: { readonly as?: string }) => {
      const relation = options.as?.trim();
      const result = await linkContacts(contactsFile(), personA, personB, relation && relation.length > 0 ? relation : undefined);
      if (!result.ok) {
        io.stderr(`Could not link: ${result.reason}. Add both people first with \`muse contacts add\`.\n`);
        process.exitCode = 1;
        return;
      }
      io.stdout(`Linked ${personA} ${relation ? `(${relation}) ` : ""}↔ ${personB}. Ask "who ${relation ?? "is connected to"} ${personA}?" to recall it.\n`);
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

  contacts
    .command("network")
    .description("Show a person's circle — their direct connections AND who they reach through them, e.g. `muse contacts network Bob`")
    .argument("<name...>", "Name or alias of the person whose network to show, e.g. 'Bob' or 'Sarah Kim'")
    .action(async (nameParts: readonly string[]) => {
      const query = nameParts.join(" ").trim();
      if (query.length === 0) {
        io.stderr("usage: muse contacts network <name>\n");
        process.exitCode = 1;
        return;
      }
      const all = await queryContacts(contactsFile());
      const resolution = resolveContact(all, query);
      if (resolution.status === "ambiguous") {
        io.stderr(`'${query}' is ambiguous — did you mean one of:\n`);
        for (const match of resolution.matches) {
          io.stderr(`  - ${describeContact(match)}\n`);
        }
        process.exitCode = 1;
        return;
      }
      if (resolution.status !== "resolved") {
        io.stderr(`No contact matches '${query}'. Add one with \`muse contacts add\`.\n`);
        process.exitCode = 1;
        return;
      }
      io.stdout(formatContactNetwork(resolution.contact.name, buildContactNetwork(all, resolution.contact)));
    });

  contacts
    .command("related")
    .description("Who you mention ALONGSIDE someone in your notes — inferred relationship edges by PMI co-occurrence (Church & Hanks 1990), the discovered sibling of the explicit `contacts link`. Read-only, deterministic, no model. e.g. `muse contacts related Sarah`")
    .argument("<name...>", "Name or alias of the person, e.g. 'Sarah' or 'Sarah Kim'")
    .option("--min-shared <n>", "Min notes in common to count as an edge (default 1)")
    .option("--limit <n>", "Max related people to show (default 10)")
    .option("--json", "Emit a structured payload")
    .action(async (nameParts: readonly string[], options: { readonly minShared?: string; readonly limit?: string; readonly json?: boolean }) => {
      const query = nameParts.join(" ").trim();
      if (query.length === 0) {
        io.stderr("usage: muse contacts related <name>\n");
        process.exitCode = 1;
        return;
      }
      const parsePositiveInt = (raw: string | undefined, label: string): number | undefined => {
        if (raw === undefined) return undefined;
        const parsed = Number(raw.trim());
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`${label} must be a positive number (got '${raw}')`);
        }
        return Math.trunc(parsed);
      };
      const minShared = parsePositiveInt(options.minShared, "--min-shared");
      const limit = parsePositiveInt(options.limit, "--limit");

      const all = await queryContacts(contactsFile());
      const resolution = resolveContact(all, query);
      if (resolution.status === "ambiguous") {
        io.stderr(`'${query}' is ambiguous — did you mean one of:\n`);
        for (const match of resolution.matches) io.stderr(`  - ${describeContact(match)}\n`);
        process.exitCode = 1;
        return;
      }
      if (resolution.status !== "resolved") {
        io.stderr(`No contact matches '${query}'. Add one with \`muse contacts add\`.\n`);
        process.exitCode = 1;
        return;
      }
      const target = resolution.contact;
      const noteBodies = await readNoteBodies(resolveNotesDir(process.env as Record<string, string | undefined>));
      const related = relatedByCooccurrence({
        contacts: all.map((c) => ({ aliases: c.aliases, id: c.id, name: c.name })),
        limit,
        minShared,
        noteBodies,
        targetId: target.id
      });
      const byId = new Map(all.map((c) => [c.id, c]));

      if (options.json) {
        io.stdout(`${JSON.stringify({
          person: target.name,
          related: related.map((r) => ({ name: byId.get(r.id)?.name ?? r.id, pmi: Number(r.pmi.toFixed(3)), sharedNotes: r.sharedNotes }))
        }, null, 2)}\n`);
        return;
      }
      if (related.length === 0) {
        io.stdout(`(no co-mentions for ${target.name} in your notes — relationships here are inferred from notes that name both people)\n`);
        return;
      }
      io.stdout(`🔗 People you mention alongside ${target.name} in your notes:\n`);
      for (const r of related) {
        const c = byId.get(r.id);
        const role = c?.relationship ? ` [your ${c.relationship}]` : "";
        io.stdout(`  - ${c?.name ?? r.id}${role} — ${r.sharedNotes.toString()} note${r.sharedNotes === 1 ? "" : "s"} together\n`);
      }
    });

  contacts
    .command("encrypt")
    .description("Encrypt the people graph at rest (AES-256-GCM; key = MUSE_MEMORY_KEY or per-host)")
    .option("--json", "Emit a structured result")
    .action(async (options: { readonly json?: boolean }) => {
      const file = contactsFile();
      const result = await encryptContactsAtRest(file);
      if (options.json) {
        io.stdout(`${JSON.stringify({ encrypted: true, file, ...result }, null, 2)}\n`);
        return;
      }
      if (result.alreadyEncrypted) {
        io.stdout(`Contacts are already encrypted at rest (${file}).\n`);
        return;
      }
      io.stdout(
        `Encrypted contacts at rest: ${file}\n` +
        (result.backupPath
          ? `Plaintext backup saved: ${result.backupPath}\n` +
            `  ⚠ This backup is CLEARTEXT — it holds your full people graph unencrypted.\n` +
            `  Delete it once you've confirmed 'muse contacts list' still works with your key.\n`
          : "") +
        `Set MUSE_MEMORY_KEY to a stable secret so the key survives a host/user change.\n`
      );
    });

  contacts
    .command("decrypt")
    .description("Revert the people graph to plaintext at rest")
    .option("--json", "Emit a structured result")
    .action(async (options: { readonly json?: boolean }) => {
      const file = contactsFile();
      const result = await decryptContactsAtRest(file);
      if (options.json) {
        io.stdout(`${JSON.stringify({ encrypted: false, file, ...result }, null, 2)}\n`);
        return;
      }
      io.stdout(
        result.alreadyPlaintext
          ? `Contacts are already plaintext at rest (${file}).\n`
          : `Reverted contacts to plaintext at rest: ${file}\n`
      );
    });

  contacts
    .command("encryption-status")
    .description("Report whether the people graph is encrypted at rest (no key needed)")
    .option("--json", "Emit a structured result")
    .action(async (options: { readonly json?: boolean }) => {
      const file = contactsFile();
      const encrypted = await isContactsEncrypted(file);
      if (options.json) {
        io.stdout(`${JSON.stringify({ encrypted, file }, null, 2)}\n`);
        return;
      }
      io.stdout(`Contacts at rest: ${encrypted ? "ENCRYPTED" : "plaintext"} (${file})\n`);
    });
}
