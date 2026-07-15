/**
 * Grounded vision actions for `muse ask`, lifted out of the commands-ask god-file:
 * --extract / --to-calendar / --auto read the IMAGE (not notes) and emit structured
 * output / a draft action, so they short-circuit the normal recall+grounding flow.
 * Every path here terminates the command (sets process.exitCode + returns), so the
 * caller invokes this and returns immediately when any of the three flags is set.
 * Both require --image. Draft-first — a state-changing route only performs with
 * --apply, and only after the field-level grounding gate passes.
 */

import { extractStructuredFromImage } from "@muse/agent-core";
import { buildCalendarRegistry, resolveContactsFile, resolveNotesDir, resolveVisionModel, type MuseEnvironment } from "@muse/autoconfigure";
import type { ModelProvider } from "@muse/model";
import { isRecord } from "@muse/shared";

import type { ProgramIO } from "./program.js";

/**
 * Resolve the vision-surface model for this session, with a best-effort Ollama
 * availability check so a swap to an OPTIONAL vision model that isn't pulled
 * fails soft to the chat model instead of erroring. The `/api/tags` probe runs
 * ONLY when a swap is actually in play (the pure resolver already returned a
 * DIFFERENT model with no availability data) — the common no-swap path adds zero
 * latency. A probe failure/timeout leaves the pure resolver's choice, whose own
 * fail-soft (the vision primitive returns `{ ok:false }`, never throws) backstops.
 */
export async function resolveSessionVisionModel(sessionModel: string, env: MuseEnvironment): Promise<string> {
  const desired = resolveVisionModel({ env, sessionModel });
  if (desired === sessionModel || !desired.startsWith("ollama/")) {
    return desired;
  }
  const baseUrl = env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    const models = isRecord(body) && Array.isArray(body.models) ? body.models : [];
    const availableModels = models
      .filter((value): value is { name: string } => isRecord(value) && typeof value.name === "string")
      .map((entry) => entry.name);
    return resolveVisionModel({ availableModels, env, sessionModel });
  } catch {
    return desired;
  }
}

export async function runVisionCommandAction(params: {
  readonly options: {
    readonly auto?: boolean;
    readonly toCalendar?: boolean;
    readonly extract?: string;
    readonly apply?: boolean;
    readonly json?: boolean;
  };
  readonly imageAttachments: ReadonlyArray<{ readonly mimeType: string; readonly dataBase64: string }>;
  readonly modelProvider: ModelProvider;
  readonly model: string;
  readonly userKey: string;
  readonly io: ProgramIO;
}): Promise<void> {
  const { options, imageAttachments, modelProvider, model, userKey, io } = params;

  if (imageAttachments.length === 0) {
    io.stderr("--extract / --to-calendar / --auto require --image <path>\n");
    process.exitCode = 1;
    return;
  }
  const img = imageAttachments[0]!;
  if (options.auto) {
    const { classifyVisionAction, normalizeStartsAt, splitUnverified, dropUnverifiedOptional } = await import("./vision-actions.js");
    const action = await classifyVisionAction(modelProvider, { imageBase64: img.dataBase64, mimeType: img.mimeType, model });
    if ("ok" in action && action.ok === false) {
      io.stderr(`muse ask --auto: ${action.error}\n`);
      process.exitCode = 1;
      return;
    }
    let act = action as import("./vision-actions.js").VisionAction;
    io.stdout(`${act.draftText}\n`);
    if (act.route === "none") {
      return;
    }
    if (options.apply !== true) {
      io.stdout("\n(draft only — re-run with --apply to perform it)\n");
      return;
    }
    // Grounding gate (fail-close, field-level): a field that couldn't be
    // confirmed against an independent transcription of the image is a
    // fabrication risk. A REQUIRED un-grounded field blocks the WHOLE action
    // (the grounded core is meaningless without it). An OPTIONAL un-grounded
    // field is DROPPED — the action recomposes WITHOUT it (the dropped value
    // is never persisted) and the grounded core still applies.
    const { blocking, droppable } = splitUnverified(act);
    if (blocking.length > 0) {
      io.stderr(`\n⚠ not applied — these field(s) couldn't be verified against the image: ${blocking.join(", ")}. Check them and correct the source, then re-run.\n`);
      process.exitCode = 1;
      return;
    }
    if (droppable.length > 0) {
      act = dropUnverifiedOptional(act, droppable);
      io.stdout(`\nℹ dropped unverified optional field(s) — applying the grounded core only: ${droppable.join(", ")}\n`);
    }
    const env = process.env;
    let result: unknown;
    if (act.route === "calendar") {
      const { createCalendarMcpServer } = await import("@muse/domain-tools");
      const addTool = createCalendarMcpServer({ registry: buildCalendarRegistry(env) }).tools.find((t) => t.name === "add");
      result = await addTool?.execute({ ...act.fields, startsAt: normalizeStartsAt(String(act.fields.startsAt)) });
    } else if (act.route === "note") {
      const { createNotesMcpServer } = await import("@muse/domain-tools");
      const appendTool = createNotesMcpServer({ notesDir: resolveNotesDir(env) }).tools.find((t) => t.name === "append");
      const notePath = typeof act.fields.path === "string" ? act.fields.path : "expenses.md";
      const noteContent = act.kind === "receipt" ? `- ${String(act.fields.note)}\n` : `${String(act.fields.note)}\n`;
      result = await appendTool?.execute({ content: noteContent, path: notePath });
    } else {
      const { addContact, readContacts } = await import("@muse/stores");
  const { createContactsAddTool } = await import("@muse/domain-tools");
      const file = resolveContactsFile(env);
      // Use the store's id-idempotent + queued addContact (not a raw read+append):
      // with the tool's name-match id-reuse this UPDATES an existing contact in
      // place instead of duplicating, and is lost-update safe under concurrency.
      const addContactTool = createContactsAddTool({ contacts: () => readContacts(file, env), save: (c) => addContact(file, c, env) });
      result = await addContactTool.execute(act.fields, { runId: "vision-auto", userId: userKey });
    }
    io.stdout(errorText(result) ? `\n❌ ${String(errorText(result))}\n` : `\n✅ Done: ${JSON.stringify(result)}\n`);
    return;
  }
  if (options.toCalendar) {
    const ex = await extractStructuredFromImage(modelProvider, {
      imageBase64: img.dataBase64,
      instruction: "Extract a calendar event from this image: its title, the start date/time (startsAt, copied EXACTLY as shown, e.g. '2026-06-20 19:00' or 'June 20 7pm'), plus location and notes if present. Omit any field that isn't visible.",
      mimeType: img.mimeType,
      model,
      schema: { properties: { location: { type: "string" }, notes: { type: "string" }, startsAt: { type: "string" }, title: { type: "string" } }, required: ["title", "startsAt"], type: "object" }
    });
    if (!ex.ok || typeof ex.data?.title !== "string" || typeof ex.data?.startsAt !== "string") {
      io.stderr(`muse ask --to-calendar: couldn't read an event from the image (${ex.error ?? "no visible title/start time"}).\n`);
      process.exitCode = 1;
      return;
    }
    const ev = ex.data;
    io.stdout(`📅 Draft event from the image:\n  title: ${String(ev.title)}\n  startsAt: ${String(ev.startsAt)}${typeof ev.location === "string" ? `\n  location: ${ev.location}` : ""}${typeof ev.notes === "string" ? `\n  notes: ${ev.notes}` : ""}\n`);
    if (options.apply !== true) {
      io.stdout("\n(draft only — re-run with --apply to create it)\n");
      return;
    }
    const { createCalendarMcpServer } = await import("@muse/domain-tools");
    const registry = buildCalendarRegistry(process.env);
    const addTool = createCalendarMcpServer({ registry }).tools.find((t) => t.name === "add");
    if (!addTool) { io.stderr("no calendar provider configured\n"); process.exitCode = 1; return; }
    const res = await addTool.execute({
      startsAt: String(ev.startsAt),
      title: String(ev.title),
      ...(typeof ev.location === "string" ? { location: ev.location } : {}),
      ...(typeof ev.notes === "string" ? { notes: ev.notes } : {})
    });
    io.stdout(errorText(res) ? `\n❌ ${String(errorText(res))}\n` : `\n✅ Created: ${JSON.stringify(res)}\n`);
    return;
  }
  const fields = (options.extract ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  if (fields.length === 0) {
    io.stderr("--extract needs at least one field, e.g. --extract 'merchant,total,date'\n");
    process.exitCode = 1;
    return;
  }
  const ex = await extractStructuredFromImage(modelProvider, {
    imageBase64: img.dataBase64,
    instruction: `Extract these fields from the image: ${fields.join(", ")}.`,
    mimeType: img.mimeType,
    model,
    schema: { properties: Object.fromEntries(fields.map((f) => [f, { type: "string" }])), type: "object" }
  });
  if (!ex.ok) {
    io.stderr(`muse ask --extract: ${ex.error}\n`);
    process.exitCode = 1;
    return;
  }
  io.stdout(`${JSON.stringify(ex.data, null, options.json === true ? 0 : 2)}\n`);
}

function errorText(value: unknown): string | undefined {
  if (!isRecord(value) || !("error" in value)) return undefined;
  const next = value.error;
  return typeof next === "string" ? next : undefined;
}
