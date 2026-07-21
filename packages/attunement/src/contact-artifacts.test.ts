import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encryptContactsAtRest, writeContacts } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { AttunementStoreError } from "./attunement-store.js";
import { createContactArtifactValidator, createContactExactArtifactResolver } from "./contact-artifacts.js";

function contactsFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-contact-artifact-")), "contacts.json");
}

function link(artifactId: string) {
  return {
    artifactId,
    artifactType: "contact" as const,
    linkedAt: "2026-07-22T00:00:00.000Z",
    linkedBy: "user" as const,
    providerId: "local",
    role: "context" as const,
    threadId: "thread_life"
  };
}

describe("contact Continuity artifact adapter", () => {
  it("preserves the exact contact id and projects only bounded non-address fields", async () => {
    const file = contactsFile();
    const id = "사람_Aa";
    writeFileSync(file, JSON.stringify({ contacts: [{
      about: `  ${"context ".repeat(50)}  `,
      aliases: ["Minji"],
      birthday: "  03-14  ",
      connections: [{ as: "friend", to: "Alex" }],
      email: "private@example.com",
      handle: "@private",
      id,
      name: "Kim   Minji",
      phone: "+82 10 0000 0000",
      relationship: "  close   friend  "
    }] }), "utf8");

    const options = { contactsFile: file };
    await expect(createContactArtifactValidator(options)({
      artifactId: id,
      artifactType: "contact",
      providerId: "local"
    })).resolves.toEqual({ artifactId: id, artifactType: "contact", providerId: "local" });

    const resolved = await createContactExactArtifactResolver(options)(link(id));
    expect(resolved).toEqual({
      artifactId: id,
      artifactType: "contact",
      contactBirthday: "03-14",
      contactRelationship: "close friend",
      providerId: "local",
      role: "context",
      summary: expect.stringMatching(/^context/u),
      title: "Kim Minji"
    });
    expect(resolved?.summary).toHaveLength(240);
    expect(JSON.stringify(resolved)).not.toMatch(/private|aliases|connections|email|phone|handle/u);
  });

  it("never resolves names, aliases, prefixes, addresses, or case variants", async () => {
    const file = contactsFile();
    writeFileSync(file, JSON.stringify({ contacts: [{
      aliases: ["Minnie"],
      email: "minji@example.com",
      id: "Person_Aa",
      name: "Kim Minji"
    }] }), "utf8");
    const validate = createContactArtifactValidator({ contactsFile: file });
    for (const artifactId of ["Kim Minji", "Minnie", "Person_", "minji@example.com", "person_Aa"]) {
      await expect(validate({ artifactId, artifactType: "contact", providerId: "local" }))
        .rejects.toThrow(`no local contact with exact id '${artifactId}'`);
    }
    await expect(createContactExactArtifactResolver({ contactsFile: file })(link("person_Aa"))).resolves.toBeUndefined();
  });

  it("fails closed on malformed source bytes without changing or quarantining them", async () => {
    const file = contactsFile();
    const malformed = '{"contacts":[{"id":"person_1","name":"Minji","email":7}]}';
    writeFileSync(file, malformed, "utf8");
    const validate = createContactArtifactValidator({ contactsFile: file });
    await expect(validate({ artifactId: "person_1", artifactType: "contact", providerId: "local" }))
      .rejects.toBeInstanceOf(AttunementStoreError);
    expect(readFileSync(file, "utf8")).toBe(malformed);
    expect(readdirSync(join(file, ".."))).toEqual(["contacts.json"]);
  });

  it("drops control-bearing optional fields from the safe projection", async () => {
    const file = contactsFile();
    writeFileSync(file, JSON.stringify({ contacts: [{
      about: "trusted\u0000spoof",
      birthday: "03-14\u0085spoof",
      id: "person_safe",
      name: "Kim Minji",
      relationship: "friend\u001b[31m"
    }] }), "utf8");

    await expect(createContactExactArtifactResolver({ contactsFile: file })(link("person_safe"))).resolves.toEqual({
      artifactId: "person_safe",
      artifactType: "contact",
      providerId: "local",
      role: "context",
      title: "Kim Minji"
    });
  });

  it("maps a wrong encryption key to a byte-stable unavailable-source error", async () => {
    const file = contactsFile();
    const key = { MUSE_MEMORY_KEY: "contact-artifact-key-a" } as NodeJS.ProcessEnv;
    const wrongKey = { MUSE_MEMORY_KEY: "contact-artifact-key-b" } as NodeJS.ProcessEnv;
    await writeContacts(file, [{ id: "person_safe", name: "Kim Minji" }], key);
    await encryptContactsAtRest(file, key);
    const before = readFileSync(file);

    await expect(createContactArtifactValidator({ contactsFile: file, env: wrongKey })({
      artifactId: "person_safe",
      artifactType: "contact",
      providerId: "local"
    })).rejects.toThrow("contacts store cannot be read or validated");
    expect(readFileSync(file)).toEqual(before);
  });

  it("rejects incoherent validator calls and treats a removed exact contact as unavailable", async () => {
    const file = contactsFile();
    writeFileSync(file, JSON.stringify({ contacts: [] }), "utf8");
    const validate = createContactArtifactValidator({ contactsFile: file });
    await expect(validate({ artifactId: "person_1", artifactType: "task", providerId: "local" }))
      .rejects.toThrow("requires a local contact");
    await expect(validate({ artifactId: "person_1", artifactType: "contact", providerId: "mcp:contacts" }))
      .rejects.toThrow("requires a local contact");
    await expect(createContactExactArtifactResolver({ contactsFile: file })(link("person_1"))).resolves.toBeUndefined();
  });
});
