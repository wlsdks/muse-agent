import {
  ContactStoreUnavailableError,
  readContactByIdStrict,
  type Contact
} from "@muse/stores";

import { AttunementStoreError } from "./attunement-store.js";

import type { ArtifactLinkValidator } from "./attunement-store.js";
import type { ExactArtifactResolver, ResolvedArtifact } from "./types.js";

export interface ContactArtifactOptions {
  readonly contactsFile: string;
  readonly env?: NodeJS.ProcessEnv;
}

function bounded(value: string | undefined): string | undefined {
  if (value && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

function projectContact(
  contact: Contact,
  artifactId: string,
  role: "context" | "next-step"
): ResolvedArtifact | undefined {
  const title = bounded(contact.name);
  if (!title || contact.id !== artifactId) return undefined;
  const contactBirthday = bounded(contact.birthday);
  const contactRelationship = bounded(contact.relationship);
  const summary = bounded(contact.about);
  return {
    artifactId,
    artifactType: "contact",
    providerId: "local",
    role,
    ...(contactBirthday ? { contactBirthday } : {}),
    ...(contactRelationship ? { contactRelationship } : {}),
    ...(summary ? { summary } : {}),
    title
  };
}

async function readExactContact(options: ContactArtifactOptions, artifactId: string): Promise<Contact | undefined> {
  try {
    return await readContactByIdStrict(options.contactsFile, artifactId, options.env);
  } catch (cause) {
    if (cause instanceof ContactStoreUnavailableError) throw new AttunementStoreError(cause.message);
    throw new AttunementStoreError("contacts store cannot be read or validated");
  }
}

/** Validate one user-supplied exact contact id; never search names, aliases, or addresses. */
export function createContactArtifactValidator(options: ContactArtifactOptions): ArtifactLinkValidator {
  return async ({ artifactId, artifactType, providerId }) => {
    if (artifactType !== "contact" || providerId !== "local") {
      throw new AttunementStoreError("contact validation requires a local contact");
    }
    const contact = await readExactContact(options, artifactId);
    if (!contact || !projectContact(contact, artifactId, "context")) {
      throw new AttunementStoreError(`no local contact with exact id '${artifactId}'`);
    }
    return { artifactId, artifactType, providerId };
  };
}

/** Resolve a linked contact to a deliberately narrow display projection. */
export function createContactExactArtifactResolver(options: ContactArtifactOptions): ExactArtifactResolver {
  return async (link) => {
    if (link.artifactType !== "contact" || link.providerId !== "local") return undefined;
    const contact = await readExactContact(options, link.artifactId);
    return contact ? projectContact(contact, link.artifactId, link.role) : undefined;
  };
}
