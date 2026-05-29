/**
 * `muse user model` — the typed USER MODEL the persona renders. Distinct from
 * the flat `muse memory` facts/preferences: structured slots
 * (preference / schedule / veto / goal) with confidence + provenance that
 * `composeUserModelSnapshot` injects into the system prompt, deepening over
 * time. This is the manual write path; the auto-extractor (2b) fills the same
 * slots from behavior. Backed by FileUserMemoryStore (same ~/.muse store).
 */

import { FileUserMemoryStore, type UserModelSlot } from "@muse/memory";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

const KINDS = ["preference", "schedule", "veto", "goal"] as const;
type SlotKind = (typeof KINDS)[number];

function resolveUserId(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUSE_USER_ID?.trim() || env.USER?.trim() || "user";
}

export function slugifySlotId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32);
  return slug.length > 0 ? slug : "slot";
}

export function buildUserModelSlot(
  kind: SlotKind,
  value: string,
  options: { readonly id?: string; readonly category?: string; readonly recurrence?: string; readonly scope?: string; readonly confidence?: string },
  now: Date
): UserModelSlot {
  const id = options.id?.trim() || slugifySlotId(value);
  const trimmed = value.trim();
  const confidence = options.confidence !== undefined ? Number(options.confidence) : undefined;
  if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new Error("--confidence must be a number in [0, 1]");
  }
  const base = { id, updatedAt: now, value: trimmed, ...(confidence !== undefined ? { confidence } : {}) };
  switch (kind) {
    case "preference":
      return { ...base, kind: "preference", ...(options.category ? { category: options.category } : {}) };
    case "schedule":
      return { ...base, kind: "schedule", ...(options.recurrence ? { recurrence: options.recurrence } : {}) };
    case "veto":
      return { ...base, kind: "veto", ...(options.scope ? { scope: options.scope } : {}) };
    case "goal":
      return { ...base, kind: "goal" };
  }
}

export function registerUserCommands(program: Command, io: ProgramIO): void {
  const model = program
    .command("user")
    .description("The typed user model Muse keeps about you (persona-injected)")
    .command("model")
    .description("Structured preferences / schedule / vetoes / goals (richer than flat `muse memory`)");

  model
    .command("add <kind> <value...>")
    .description("Add/update a typed slot (kind: preference | schedule | veto | goal). Same id → replaces.")
    .option("--id <id>", "Slot id (default: a slug of the value, so re-adding the same value updates it)")
    .option("--category <c>", "preference category, e.g. style/format/language")
    .option("--recurrence <r>", "schedule recurrence, e.g. 'daily 07:00 KST'")
    .option("--scope <s>", "veto scope, e.g. food/tooling/meetings")
    .option("--confidence <n>", "0..1 confidence (default: omitted, i.e. asserted)")
    .option("--json", "Print the stored model")
    .action(async (kind: string, valueParts: readonly string[], options: { readonly id?: string; readonly category?: string; readonly recurrence?: string; readonly scope?: string; readonly confidence?: string; readonly json?: boolean }) => {
      if (!(KINDS as readonly string[]).includes(kind)) {
        throw new Error(`kind must be one of: ${KINDS.join(" | ")}`);
      }
      const value = valueParts.join(" ").trim();
      if (value.length === 0) throw new Error("value is required");
      const slot = buildUserModelSlot(kind as SlotKind, value, options, new Date());
      const store = new FileUserMemoryStore();
      const updated = await store.upsertUserModelSlot(resolveUserId(), slot);
      if (options.json) {
        io.stdout(`${JSON.stringify(updated.userModel, null, 2)}\n`);
        return;
      }
      io.stdout(`Saved ${kind} [${slot.id}]: ${value}\n`);
    });

  model
    .command("list")
    .description("Show the typed user model")
    .option("--json", "Print the raw model")
    .action(async (options: { readonly json?: boolean }) => {
      const snap = await new FileUserMemoryStore().findByUserId(resolveUserId());
      const um = snap?.userModel;
      if (options.json) {
        io.stdout(`${JSON.stringify(um ?? null, null, 2)}\n`);
        return;
      }
      if (!um || (um.preferences.length + um.schedule.length + um.vetoes.length + um.goals.length) === 0) {
        io.stdout("Your typed user model is empty. Add with `muse user model add <kind> <value>`.\n");
        return;
      }
      const section = (title: string, slots: readonly { id: string; value: string }[]): void => {
        if (slots.length === 0) return;
        io.stdout(`${title}:\n`);
        for (const s of slots) io.stdout(`  - [${s.id}] ${s.value}\n`);
      };
      section("Preferences", um.preferences);
      section("Schedule", um.schedule);
      section("Vetoes", um.vetoes);
      section("Goals", um.goals);
    });

  model
    .command("remove <id>")
    .description("Remove a slot by id")
    .action(async (id: string) => {
      await new FileUserMemoryStore().removeUserModelSlot(resolveUserId(), id.trim());
      io.stdout(`Removed slot [${id.trim()}]\n`);
    });
}
