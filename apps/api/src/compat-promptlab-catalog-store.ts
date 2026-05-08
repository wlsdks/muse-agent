/**
 * Reactor-compat promptlab catalog store helpers extracted from
 * reactor-compat-routes.ts. Covers persona, prompt-template (+ versions),
 * and intent CRUD.
 *
 * Each store helper dispatches to options.promptLabCatalogStore (the
 * configured promptlab catalog store) when present, otherwise falls back
 * to the file-private compat state via three new accessors
 * (getStatePersonas, getStatePromptTemplates, getStateIntents). Pairs with
 * persona-compat-routes, prompt-template-compat-routes, and
 * intent-compat-routes.
 */

import { createRunId, type JsonObject } from "@muse/shared";
import type { FastifyRequest } from "fastify";
import { prepareCatalogRecord, promptLabRecordToCompat } from "./compat-prompt-experiment.js";
import {
  createRecord,
  epochMillisOrNull,
  findCompatRecord,
  getStateIntents,
  getStatePersonas,
  getStatePromptTemplates,
  isRecord,
  jsonObjectField,
  nowIso,
  nullableStringResponse,
  reactorEnumString,
  readBodyString,
  readBoolean,
  readNullableStringField,
  readNumber,
  readOptionalStringField,
  stringArrayField,
  stringField,
  toBody,
  toJsonObject,
  type CompatBody,
  type CompatRecord,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export async function createPersona(options: ReactorCompatibilityRouteOptions, bodyValue: unknown): Promise<CompatRecord> {
  const body = toBody(bodyValue);
  return savePersona(options, {
    description: readNullableStringField(body, "description"),
    icon: readNullableStringField(body, "icon"),
    isActive: readBoolean(body.isActive, true),
    isDefault: readBoolean(body.isDefault, false),
    name: readBodyString(body, "name") ?? "",
    promptTemplateId: readNullableStringField(body, "promptTemplateId"),
    responseGuideline: readNullableStringField(body, "responseGuideline"),
    systemPrompt: readBodyString(body, "systemPrompt") ?? "",
    welcomeMessage: readNullableStringField(body, "welcomeMessage")
  });
}

async function savePersona(options: ReactorCompatibilityRouteOptions, record: JsonObject): Promise<CompatRecord> {
  if (options.promptLabCatalogStore) {
    const saved = await options.promptLabCatalogStore.savePersona(prepareCatalogRecord(record, "persona"));
    return promptLabRecordToCompat(saved, "persona");
  }

  return createRecord(getStatePersonas(), record, "persona");
}

export async function listPersonas(options: ReactorCompatibilityRouteOptions): Promise<readonly CompatRecord[]> {
  if (options.promptLabCatalogStore) {
    const rows = await options.promptLabCatalogStore.listPersonas();
    return rows.map((row) => promptLabRecordToCompat(row, "persona"));
  }

  return [...getStatePersonas().values()];
}

export async function getPersona(options: ReactorCompatibilityRouteOptions, id: string): Promise<CompatRecord | undefined> {
  if (options.promptLabCatalogStore) {
    const row = await options.promptLabCatalogStore.getPersona(id);
    return row ? promptLabRecordToCompat(row, "persona") : undefined;
  }

  return findCompatRecord(getStatePersonas(), id);
}

export async function deletePersona(options: ReactorCompatibilityRouteOptions, id: string): Promise<boolean> {
  if (options.promptLabCatalogStore) {
    return options.promptLabCatalogStore.deletePersona(id);
  }

  const existing = findCompatRecord(getStatePersonas(), id);
  return existing ? getStatePersonas().delete(existing.id) : false;
}

export function validatePersonaBody(body: CompatBody, mode: "create" | "update"): JsonObject | undefined {
  const checks: Array<readonly [keyof CompatBody, number, string]> = [
    ["name", 200, "name must not exceed 200 characters"],
    ["systemPrompt", 50_000, "systemPrompt must not exceed 50000 characters"],
    ["description", 2_000, "description must not exceed 2000 characters"],
    ["responseGuideline", 10_000, "responseGuideline must not exceed 10000 characters"],
    ["welcomeMessage", 2_000, "welcomeMessage must not exceed 2000 characters"],
    ["promptTemplateId", 200, "promptTemplateId must not exceed 200 characters"],
    ["icon", 20, "icon must be 20 characters or fewer"]
  ];

  if (mode === "create" && !readBodyString(body, "name")) {
    return { name: "name must not be blank" };
  }

  if (mode === "create" && !readBodyString(body, "systemPrompt")) {
    return { systemPrompt: "systemPrompt must not be blank" };
  }

  for (const [key, max, message] of checks) {
    const value = body[key];

    if (typeof value === "string" && value.length > max) {
      return { [key]: message };
    }
  }

  return undefined;
}

export async function updatePersona(
  options: ReactorCompatibilityRouteOptions,
  existing: CompatRecord,
  bodyValue: unknown
): Promise<CompatRecord> {
  const body = toBody(bodyValue);
  return savePersona(options, {
    ...existing,
    description: readOptionalStringField(body, "description", existing.description),
    icon: readOptionalStringField(body, "icon", existing.icon),
    isActive: readBoolean(body.isActive, readBoolean(existing.isActive, true)),
    isDefault: readBoolean(body.isDefault, readBoolean(existing.isDefault, false)),
    name: readBodyString(body, "name") ?? stringField(existing.name, ""),
    promptTemplateId: readOptionalStringField(body, "promptTemplateId", existing.promptTemplateId),
    responseGuideline: readOptionalStringField(body, "responseGuideline", existing.responseGuideline),
    systemPrompt: readBodyString(body, "systemPrompt") ?? stringField(existing.systemPrompt, ""),
    welcomeMessage: readOptionalStringField(body, "welcomeMessage", existing.welcomeMessage)
  });
}

export function toPersonaResponse(record: JsonObject) {
  return {
    createdAt: epochMillisOrNull(record.createdAt) ?? Date.now(),
    description: nullableStringResponse(record.description),
    icon: nullableStringResponse(record.icon),
    id: stringField(record.id, ""),
    isActive: readBoolean(record.isActive, true),
    isDefault: readBoolean(record.isDefault, false),
    name: stringField(record.name, ""),
    promptTemplateId: nullableStringResponse(record.promptTemplateId),
    responseGuideline: nullableStringResponse(record.responseGuideline),
    systemPrompt: stringField(record.systemPrompt, ""),
    updatedAt: epochMillisOrNull(record.updatedAt) ?? Date.now(),
    welcomeMessage: nullableStringResponse(record.welcomeMessage)
  };
}

export async function createPromptTemplate(options: ReactorCompatibilityRouteOptions, bodyValue: unknown): Promise<CompatRecord> {
  const body = toBody(bodyValue);
  return savePromptTemplate(options, {
    description: readBodyString(body, "description") ?? "",
    name: readBodyString(body, "name") ?? "",
    versions: []
  });
}

export async function savePromptTemplate(options: ReactorCompatibilityRouteOptions, record: JsonObject): Promise<CompatRecord> {
  if (options.promptLabCatalogStore) {
    const saved = await options.promptLabCatalogStore.saveTemplate(prepareCatalogRecord(record, "prompt_template"));
    return promptLabRecordToCompat(saved, "prompt_template");
  }

  return createRecord(getStatePromptTemplates(), record, "prompt_template");
}

export async function listPromptTemplates(options: ReactorCompatibilityRouteOptions): Promise<readonly CompatRecord[]> {
  if (options.promptLabCatalogStore) {
    const rows = await options.promptLabCatalogStore.listTemplates();
    return rows.map((row) => promptLabRecordToCompat(row, "prompt_template"));
  }

  return [...getStatePromptTemplates().values()];
}

export async function getPromptTemplate(
  options: ReactorCompatibilityRouteOptions,
  id: string
): Promise<CompatRecord | undefined> {
  if (options.promptLabCatalogStore) {
    const row = await options.promptLabCatalogStore.getTemplate(id);
    return row ? promptLabRecordToCompat(row, "prompt_template") : undefined;
  }

  return findCompatRecord(getStatePromptTemplates(), id);
}

export async function deletePromptTemplate(options: ReactorCompatibilityRouteOptions, id: string): Promise<boolean> {
  if (options.promptLabCatalogStore) {
    return options.promptLabCatalogStore.deleteTemplate(id);
  }

  return getStatePromptTemplates().delete(id);
}

export function validatePromptTemplateBody(body: CompatBody, mode: "create" | "update"): JsonObject | undefined {
  const name = body.name;
  const description = body.description;

  if (mode === "create" && !readBodyString(body, "name")) {
    return { name: "name must not be blank" };
  }

  if (typeof name === "string" && name.length > 200) {
    return { name: "name must not exceed 200 characters" };
  }

  if (typeof description === "string" && description.length > 2000) {
    return { description: "description must not exceed 2000 characters" };
  }

  return undefined;
}

export function validatePromptVersionBody(body: CompatBody): JsonObject | undefined {
  const content = body.content;
  const changeLog = body.changeLog;

  if (!readBodyString(body, "content")) {
    return { content: "content must not be blank" };
  }

  if (typeof content === "string" && content.length > 100_000) {
    return { content: "content must not exceed 100000 characters" };
  }

  if (typeof changeLog === "string" && changeLog.length > 2000) {
    return { changeLog: "changeLog must not exceed 2000 characters" };
  }

  return undefined;
}

export function toTemplateResponse(record: JsonObject) {
  return {
    createdAt: epochMillisOrNull(record.createdAt) ?? Date.now(),
    description: typeof record.description === "string" ? record.description : "",
    id: typeof record.id === "string" ? record.id : "",
    name: typeof record.name === "string" ? record.name : "",
    updatedAt: epochMillisOrNull(record.updatedAt) ?? Date.now()
  };
}

export function toTemplateDetailResponse(record: JsonObject) {
  const versions = promptVersions(record);
  const activeVersion = versions.find((version) => version.status === "ACTIVE") ?? null;
  return {
    ...toTemplateResponse(record),
    activeVersion,
    versions
  };
}

export async function appendPromptVersion(
  options: ReactorCompatibilityRouteOptions,
  templateId: string,
  bodyValue: unknown
): Promise<JsonObject | { error: string }> {
  const template = await getPromptTemplate(options, templateId);

  if (!template) {
    return { error: "not_found" };
  }

  const body = toBody(bodyValue);
  const existing = promptVersions(template);
  const version = {
    changeLog: readBodyString(body, "changeLog") ?? "",
    content: readBodyString(body, "content") ?? "",
    createdAt: nowIso(),
    id: createRunId("prompt_version"),
    status: "DRAFT",
    templateId,
    version: existing.length + 1
  };

  await savePromptTemplate(options, {
    ...template,
    versions: [...existing, version]
  });
  return toVersionResponse(version);
}

export async function setPromptVersionStatus(
  options: ReactorCompatibilityRouteOptions,
  request: FastifyRequest,
  status: "ACTIVE" | "ARCHIVED"
): Promise<JsonObject | { error: string }> {
  const { templateId, versionId } = request.params as { readonly templateId: string; readonly versionId: string };
  const template = await getPromptTemplate(options, templateId);

  if (!template) {
    return { error: "not_found" };
  }

  let selected: JsonObject | undefined;
  const versions = promptVersions(template).map((version) => {
    if (version.id === versionId) {
      selected = { ...version, status };
      return selected;
    }

    return status === "ACTIVE" && version.status === "ACTIVE"
      ? { ...version, status: "ARCHIVED" }
      : version;
  });

  if (!selected) {
    return { error: "not_found" };
  }

  await savePromptTemplate(options, {
    ...template,
    versions
  });
  return toVersionResponse(selected);
}

export function promptVersions(record: JsonObject): JsonObject[] {
  return Array.isArray(record.versions)
    ? record.versions.filter(isRecord).map(toJsonObject)
    : [];
}

export function toVersionResponse(record: JsonObject) {
  return {
    changeLog: typeof record.changeLog === "string" ? record.changeLog : "",
    content: typeof record.content === "string" ? record.content : "",
    createdAt: epochMillisOrNull(record.createdAt) ?? Date.now(),
    id: typeof record.id === "string" ? record.id : "",
    status: reactorEnumString(record.status, "DRAFT"),
    templateId: typeof record.templateId === "string" ? record.templateId : "",
    version: typeof record.version === "number" ? record.version : readNumber(record.version, 1)
  };
}

export async function createIntent(options: ReactorCompatibilityRouteOptions, bodyValue: unknown): Promise<CompatRecord> {
  const body = toBody(bodyValue);
  const name = readBodyString(body, "name") ?? "";
  return saveIntent(options, {
    description: readBodyString(body, "description") ?? "",
    enabled: readBoolean(body.enabled, true),
    examples: stringArrayField(body.examples, []),
    id: name,
    keywords: stringArrayField(body.keywords, []),
    name,
    profile: jsonObjectField(body.profile)
  });
}

async function saveIntent(options: ReactorCompatibilityRouteOptions, record: JsonObject): Promise<CompatRecord> {
  if (options.promptLabCatalogStore) {
    const saved = await options.promptLabCatalogStore.saveIntent(prepareCatalogRecord(record, "intent"));
    return promptLabRecordToCompat(saved, "intent");
  }

  return createRecord(getStateIntents(), record, "intent");
}

export async function listIntents(options: ReactorCompatibilityRouteOptions): Promise<readonly CompatRecord[]> {
  if (options.promptLabCatalogStore) {
    const rows = await options.promptLabCatalogStore.listIntents();
    return rows.map((row) => promptLabRecordToCompat(row, "intent"));
  }

  return [...getStateIntents().values()];
}

export async function getIntent(options: ReactorCompatibilityRouteOptions, name: string): Promise<CompatRecord | undefined> {
  if (options.promptLabCatalogStore) {
    const row = await options.promptLabCatalogStore.getIntent(name);
    return row ? promptLabRecordToCompat(row, "intent") : undefined;
  }

  return findCompatRecord(getStateIntents(), name);
}

export async function deleteIntent(options: ReactorCompatibilityRouteOptions, name: string): Promise<boolean> {
  if (options.promptLabCatalogStore) {
    return options.promptLabCatalogStore.deleteIntent(name);
  }

  const existing = findCompatRecord(getStateIntents(), name);
  return existing ? getStateIntents().delete(existing.id) : false;
}

export function validateIntentBody(body: CompatBody, mode: "create" | "update"): JsonObject | undefined {
  if (mode === "create" && !readBodyString(body, "name")) {
    return { name: "name must not be blank" };
  }

  if (mode === "create" && !readBodyString(body, "description")) {
    return { description: "description must not be blank" };
  }

  return undefined;
}

export async function updateIntent(
  options: ReactorCompatibilityRouteOptions,
  existing: CompatRecord,
  bodyValue: unknown
): Promise<CompatRecord> {
  const body = toBody(bodyValue);
  return saveIntent(options, {
    ...existing,
    description: readBodyString(body, "description") ?? stringField(existing.description, ""),
    enabled: readBoolean(body.enabled, readBoolean(existing.enabled, true)),
    examples: stringArrayField(body.examples, stringArrayField(existing.examples, [])),
    keywords: stringArrayField(body.keywords, stringArrayField(existing.keywords, [])),
    profile: isRecord(body.profile) ? toJsonObject(body.profile) : jsonObjectField(existing.profile)
  });
}

export function toIntentResponse(record: JsonObject) {
  return {
    createdAt: epochMillisOrNull(record.createdAt) ?? Date.now(),
    description: stringField(record.description, ""),
    enabled: readBoolean(record.enabled, true),
    examples: stringArrayField(record.examples, []),
    keywords: stringArrayField(record.keywords, []),
    name: stringField(record.name, stringField(record.id, "")),
    profile: jsonObjectField(record.profile),
    updatedAt: epochMillisOrNull(record.updatedAt) ?? Date.now()
  };
}
