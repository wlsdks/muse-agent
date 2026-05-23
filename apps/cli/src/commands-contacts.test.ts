import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerContactsCommands } from "./commands-contacts.js";

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
});
