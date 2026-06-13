import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { queryContacts, type Contact } from "@muse/mcp";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { filterContactsBySearch, formatOverdue, interactionsFromEvents, registerContactsCommands } from "./commands-contacts.js";

describe("B1 relationship decay — interactionsFromEvents + formatOverdue", () => {
  it("derives interaction timestamps from calendar events that mention a contact (name or alias)", () => {
    const events = [
      { title: "coffee with Mina", startsAt: "2026-05-01T10:00:00Z" },
      { title: "lunch", notes: "caught up with Mimi", startsAt: "2026-05-20T10:00:00Z" },
      { title: "team standup", startsAt: "2026-05-25T10:00:00Z" } // no mention → not counted
    ];
    const [mina] = interactionsFromEvents([{ name: "Mina", aliases: ["Mimi"] }], events);
    expect(mina!.timestampsMs).toHaveLength(2);
  });

  it("skips a name shorter than 2 chars (too ambiguous)", () => {
    const [x] = interactionsFromEvents([{ name: "A" }], [{ title: "A team standup", startsAt: "2026-05-01T10:00:00Z" }]);
    expect(x!.timestampsMs).toEqual([]);
  });

  it("formatOverdue renders the nudge (or an honest all-clear), draft-first", () => {
    expect(formatOverdue([])).toContain("No one's overdue");
    const out = formatOverdue([{ name: "Mina", cadenceDays: 7, gapDays: 35, overdueRatio: 5 }]);
    expect(out).toContain("Mina");
    expect(out).toContain("nothing is sent");
    expect(out).toMatch(/every 7d/);
  });
});

async function run(file: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prevFile = process.env.MUSE_CONTACTS_FILE;
  const prevExit = process.exitCode;
  process.env.MUSE_CONTACTS_FILE = file;
  process.exitCode = 0;
  try {
    const program = new Command();
    program.exitOverride();
    registerContactsCommands(program, io);
    await program.parseAsync(["node", "muse", "contacts", ...args]);
  } finally {
    if (prevFile === undefined) delete process.env.MUSE_CONTACTS_FILE;
    else process.env.MUSE_CONTACTS_FILE = prevFile;
  }
  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = prevExit;
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

function contactsFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-cli-contacts-")), "contacts.json");
}

describe("muse contacts import — bulk-load a vCard into the real store", () => {
  const VCF = `BEGIN:VCARD
VERSION:3.0
FN:Jane Doe
EMAIL:jane@acme.com
TEL:+1 415 555 0102
BDAY:1990-12-25
END:VCARD
BEGIN:VCARD
FN:Bob Smith
TEL:+1 555 0199
END:VCARD
BEGIN:VCARD
FN:No Way To Reach
END:VCARD
`;

  it("imports reachable cards (name + email/phone), skips bare labels, persists to the store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-vcf-"));
    const file = join(dir, "contacts.json");
    const vcf = join(dir, "addressbook.vcf");
    writeFileSync(vcf, VCF, "utf8");
    const r = await run(file, ["import", vcf]);
    expect(r.stdout).toContain("Imported 2 contacts");
    expect(r.stdout).toContain("skipped 1");
    const stored = await queryContacts(file);
    expect(stored.map((c) => c.name).sort()).toEqual(["Bob Smith", "Jane Doe"]);
    const jane = stored.find((c) => c.name === "Jane Doe")!;
    expect(jane).toMatchObject({ birthday: "1990-12-25", email: "jane@acme.com", phone: "+1 415 555 0102" });
  });

  it("de-dupes by email on re-import (no pile-up)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-vcf-dup-"));
    const file = join(dir, "contacts.json");
    const vcf = join(dir, "a.vcf");
    writeFileSync(vcf, VCF, "utf8");
    await run(file, ["import", vcf]);
    const second = await run(file, ["import", vcf]);
    expect(second.stdout).toContain("Imported 0 contacts");
    expect((await queryContacts(file)).length).toBe(2);
  });

  it("export → re-import round-trips the contacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-vcf-rt-"));
    const file = join(dir, "contacts.json");
    const out = join(dir, "out.vcf");
    writeFileSync(join(dir, "a.vcf"), VCF, "utf8");
    await run(file, ["import", join(dir, "a.vcf")]); // 2 reachable contacts
    const exp = await run(file, ["export", out]);
    expect(exp.stdout).toContain("Exported 2 contacts");
    // Re-import the export into a FRESH store → same 2 contacts.
    const file2 = join(dir, "contacts2.json");
    await run(file2, ["import", out]);
    const reimported = await queryContacts(file2);
    expect(reimported.map((c) => c.name).sort()).toEqual(["Bob Smith", "Jane Doe"]);
  });
});

describe("muse contacts — people graph + recipient resolution", () => {
  it("add → list → resolve reflects through the real ~/.muse/contacts.json store", async () => {
    const file = contactsFile();
    const added = await run(file, ["add", "Bob", "--email", "bob@example.com", "--alias", "Bobby"]);
    expect(added.stdout).toContain("Added Bob (aka Bobby) — bob@example.com");
    expect(added.exitCode).toBeUndefined();

    const listed = await run(file, ["list"]);
    expect(listed.stdout).toContain("Bob (aka Bobby) — bob@example.com");

    // Resolve by name and by alias.
    expect((await run(file, ["resolve", "Bob"])).stdout).toContain("bob@example.com");
    expect((await run(file, ["resolve", "Bobby"])).stdout).toContain("bob@example.com");
  });

  it("resolve reports AMBIGUOUS (never a guessed recipient) when two contacts share the name", async () => {
    const file = contactsFile();
    await run(file, ["add", "Bob", "--email", "bob1@example.com"]);
    await run(file, ["add", "Bob", "--email", "bob2@example.com"]);
    const r = await run(file, ["resolve", "Bob"]);
    expect(r.stderr).toContain("is ambiguous — did you mean");
    expect(r.stderr).toContain("bob1@example.com");
    expect(r.stderr).toContain("bob2@example.com");
    expect(r.exitCode).toBe(1);
    // The ambiguous result must NOT print a single resolved recipient on stdout.
    expect(r.stdout).toBe("");
  });

  it("resolve reports not-found (exit 1) for an unknown name", async () => {
    const file = contactsFile();
    await run(file, ["add", "Alice", "--handle", "@alice"]);
    const r = await run(file, ["resolve", "Carol"]);
    expect(r.stderr).toContain("No contact matches 'Carol'");
    expect(r.exitCode).toBe(1);
  });

  it("add requires at least one of --email / --handle / --phone so a contact is reachable", async () => {
    const file = contactsFile();
    const r = await run(file, ["add", "Dave"]);
    expect(r.stderr).toContain("provide at least one of --email / --handle / --phone");
    expect(r.exitCode).toBe(1);
  });

  it("add --phone persists a phone-only contact and `list` shows the number", async () => {
    const file = contactsFile();
    const added = await run(file, ["add", "Mom", "--phone", "+1 415 555 0101"]);
    expect(added.exitCode).toBeUndefined();
    expect(added.stdout).toContain("Mom — +1 415 555 0101");

    const listed = await run(file, ["list"]);
    expect(listed.stdout).toContain("Mom — +1 415 555 0101");
    expect(listed.stdout).not.toContain("(no email/handle/phone)");
  });

  it("add --birthday persists through the store and `birthdays` lists it", async () => {
    const file = contactsFile();
    const add = await run(file, ["add", "Sarah", "--email", "s@x.com", "--birthday", "12-25"]);
    expect(add.exitCode).toBeUndefined();
    // It round-trips the real store (no in-memory shortcut).
    const list = await run(file, ["birthdays", "--within", "400"]);
    expect(list.stdout).toContain("🎂 Sarah");
    expect(list.stdout).toContain("12-25");
  });

  it("add rejects a malformed --birthday", async () => {
    const file = contactsFile();
    const r = await run(file, ["add", "Sarah", "--email", "s@x.com", "--birthday", "Dec 25"]);
    expect(r.stderr).toContain("--birthday must be MM-DD or YYYY-MM-DD");
    expect(r.exitCode).toBe(1);
  });

  it("birthdays reports none when no contact has a birthday", async () => {
    const file = contactsFile();
    await run(file, ["add", "Bob", "--email", "b@x.com"]);
    const r = await run(file, ["birthdays"]);
    expect(r.stdout).toContain("No birthdays in the next 30 days");
  });

  it("birthdays --within rejects a non-numeric window instead of silently defaulting", async () => {
    const file = contactsFile();
    const r = await run(file, ["birthdays", "--within", "abc"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--within must be a positive number/);
    expect(r.stdout).toBe("");
  });

  it("birthdays --within rejects a non-positive window instead of printing a nonsense range", async () => {
    const file = contactsFile();
    const r = await run(file, ["birthdays", "--within", "-5"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain("-5 days");
  });
});

describe("filterContactsBySearch — find people in the graph by role / name / email", () => {
  const ct = (over: Partial<Contact> & { name: string }): Contact => ({ id: over.name.toLowerCase(), ...over });
  const all: Contact[] = [
    ct({ name: "Sarah Kim", relationship: "manager", email: "sarah@globex.com" }),
    ct({ name: "Bob Lee", relationship: "coworker", email: "bob@acme.com" }),
    ct({ name: "Carol Park", relationship: "coworker", handle: "@carol" }),
    ct({ name: "Mom", relationship: "mother", phone: "+1 555 0100", aliases: ["Jane"] })
  ];

  it("matches the relationship-to-you (who are my coworkers?)", () => {
    expect(filterContactsBySearch(all, "coworker").map((c) => c.name)).toEqual(["Bob Lee", "Carol Park"]);
  });

  it("matches a name substring, case-insensitively", () => {
    expect(filterContactsBySearch(all, "kim").map((c) => c.name)).toEqual(["Sarah Kim"]);
    expect(filterContactsBySearch(all, "PARK").map((c) => c.name)).toEqual(["Carol Park"]);
  });

  it("matches email domain and an alias", () => {
    expect(filterContactsBySearch(all, "globex").map((c) => c.name)).toEqual(["Sarah Kim"]);
    expect(filterContactsBySearch(all, "jane").map((c) => c.name)).toEqual(["Mom"]);
  });

  it("returns everything for an empty term, and nothing for a non-match", () => {
    expect(filterContactsBySearch(all, "   ")).toHaveLength(4);
    expect(filterContactsBySearch(all, "nobody")).toEqual([]);
  });

  it("matches the free-text `about` so a remembered fact finds the person (who likes hiking?)", () => {
    const withNote = [...all, ct({ name: "Dave Ng", relationship: "friend", about: "loves hiking and climbing" })];
    expect(filterContactsBySearch(withNote, "hiking").map((c) => c.name)).toEqual(["Dave Ng"]);
  });
});

describe("muse contacts list --search — filter the people graph end-to-end", () => {
  it("shows only the matching contacts, or a count-bearing miss message", async () => {
    const file = contactsFile();
    await run(file, ["add", "Sarah Kim", "--relationship", "manager", "--email", "sarah@globex.com"]);
    await run(file, ["add", "Bob Lee", "--relationship", "coworker", "--email", "bob@acme.com"]);
    await run(file, ["add", "Carol Park", "--relationship", "coworker", "--handle", "@carol"]);

    const hit = await run(file, ["list", "--search", "coworker"]);
    expect(hit.stdout).toContain("Bob Lee");
    expect(hit.stdout).toContain("Carol Park");
    expect(hit.stdout).not.toContain("Sarah Kim");

    const miss = await run(file, ["list", "--search", "nobody"]);
    expect(miss.stdout).toContain("No contacts match 'nobody'");
    expect(miss.stdout).toContain("3 total");
  });
});
