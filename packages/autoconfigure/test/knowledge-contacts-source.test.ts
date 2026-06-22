import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addContact, queryContacts } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assembleKnowledgeCorpus, createNotesKnowledgeSearchTool, type ContactsSource } from "../src/knowledge-corpus.js";

const VOCAB = ["bob", "acme", "renew"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

let dir: string;
let file: string;
let source: ContactsSource;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-kcontacts-"));
  file = join(dir, "contacts.json");
  source = { list: () => queryContacts(file) };
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("assembleKnowledgeCorpus — contacts as a corpus source", () => {
  it("emits each contact as a contact/<id> chunk with name + email + aliases", async () => {
    await addContact(file, { aliases: ["Bobby"], email: "bob@acme.com", id: "c1", name: "Bob Acme" });
    const corpus = await assembleKnowledgeCorpus({ contactsSource: source });
    const chunk = corpus.find((c) => c.source === "contact/Bob Acme");
    expect(chunk).toBeDefined();
    expect(chunk!.text).toContain("Bob Acme");
    expect(chunk!.text).toContain("bob@acme.com");
    expect(chunk!.text).toContain("Bobby");
  });

  it("includes a contact's phone in the chunk so knowledge_search can answer 'do I have a number for X' (853 seam)", async () => {
    await addContact(file, { id: "c2", name: "Mom", phone: "+1 415 555 0101" });
    const corpus = await assembleKnowledgeCorpus({ contactsSource: source });
    const chunk = corpus.find((c) => c.source === "contact/Mom");
    expect(chunk).toBeDefined();
    expect(chunk!.text).toContain("phone +1 415 555 0101");
  });
});

describe("knowledge_search spans contacts — finds + cites a person", () => {
  it("answers a contact query from the store and cites contact/<id>", async () => {
    await addContact(file, { email: "bob@acme.com", id: "c1", name: "Bob Acme" });
    const tool = createNotesKnowledgeSearchTool({ contactsSource: source, embed });
    const result = String(await tool.execute({ query: "what's bob acme's email?" }, { runId: "r1" }));
    expect(result).toContain("[contact/Bob Acme]");
    expect(result).toContain("bob@acme.com");
  });
});
