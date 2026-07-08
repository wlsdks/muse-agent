/**
 * `muse remember <text>` / `muse forget <key>` — natural-language
 * memory tweaks. Two top-level shortcuts so the user can train
 * JARVIS in one line from anywhere (shell aliases, scripts, voice
 * loop, ad-hoc commands) without entering the REPL.
 *
 * `muse remember "I prefer concise English replies"`
 *   → runs the auto-extract prompt against the local model
 *   → writes facts/prefs/vetoes/goals into ~/.muse/user-memory.json
 *
 * `muse forget reply_style`
 *   → drops a single key (fact OR preference) from the persona
 *
 * `muse forget --all`
 *   → wipes the entire persona for the user (requires --force)
 */

import {
  createMuseRuntimeAssembly,
  extractJsonObject,
  pickAutoExtractSystemPrompt,
  type ExtractionPayload
} from "@muse/autoconfigure";
import type { Command } from "commander";

import { consumeAskStream, type AskStreamEvent } from "./commands-ask.js";
import { resolvePersona } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

interface RememberOptions {
  readonly user?: string;
  readonly persona?: string;
  readonly model?: string;
  readonly json?: boolean;
}

interface ForgetOptions {
  readonly user?: string;
  readonly persona?: string;
  readonly all?: boolean;
  readonly force?: boolean;
}

export function envValue(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
}

export function composeKey(user: string | undefined, persona: string | undefined): string {
  const base = user ?? envValue("MUSE_USER_ID") ?? envValue("USER") ?? "default";
  const resolved = resolvePersona(persona);
  return resolved ? `${base}@${resolved}` : base;
}

export function registerRememberCommands(program: Command, io: ProgramIO): void {
  program
    .command("remember")
    .description("Tell JARVIS something in natural language — LLM extracts facts/prefs/vetoes/goals into ~/.muse/user-memory.json")
    .addHelpText("after", `
Examples:
  $ muse remember "I'm vegetarian and I hate 8am meetings"   # extracts facts/prefs/goals
  $ muse remember --json "my timezone is KST"                # structured {written,skipped} output
  $ muse forget home_city                                    # remove a single remembered fact`)
    .argument("<text...>", "Natural-language statement (one or more words)")
    .option("--user <id>", "User identity (default $MUSE_USER_ID / $USER)")
    .option("--persona <slot>", "Persona slot (work / home)")
    .option("--model <tag>", "Model override")
    .option("--json", "Emit a structured {written:[{kind,key,value}], skipped:[{...}]} payload instead of human-readable lines")
    .action(async (textParts: readonly string[], options: RememberOptions) => {
      const text = textParts.join(" ").trim();
      if (text.length === 0) {
        io.stderr("usage: muse remember <text>\n");
        process.exitCode = 1;
        return;
      }
      const userKey = composeKey(options.user, options.persona);
      const assembly = createMuseRuntimeAssembly();
      if (!assembly.modelProvider || !(options.model ?? assembly.defaultModel)) {
        io.stderr(
          "muse remember requires a configured model for natural-language extraction.\n"
          + "  Set MUSE_MODEL or pass --model, OR use the no-LLM direct path:\n"
          + `  muse memory set --local --user ${userKey} fact <key> "<value>"\n`
          + `  muse memory set --local --user ${userKey} preference <key> "<value>"\n`
        );
        process.exitCode = 2;
        return;
      }
      const model = options.model ?? assembly.defaultModel!;
      const systemPrompt = pickAutoExtractSystemPrompt(text);

      const { answer: raw, error: streamError } = await consumeAskStream(
        assembly.modelProvider.stream({
          messages: [
            { content: systemPrompt, role: "system" },
            { content: `User turn:\n${text}\n\nAssistant reply:\n(no reply yet — extract directly from the user's statement)`, role: "user" }
          ],
          model
        }) as AsyncIterable<AskStreamEvent>,
        () => {},
        () => false
      );
      if (streamError !== undefined) {
        io.stderr(`(error: ${streamError})\n`);
        process.exitCode = 1;
        return;
      }
      const payload: ExtractionPayload | undefined = extractJsonObject(raw);
      if (!payload) {
        io.stderr("(model output didn't parse as JSON — nothing written. Try rephrasing.)\n");
        process.exitCode = 1;
        return;
      }

      const written: Array<{ kind: "fact" | "preference" | "veto" | "goal"; key: string; value: string }> = [];
      const skipped: Array<{ kind: string; key?: string; reason: string }> = [];
      const emitWrite = (kind: "fact" | "preference" | "veto" | "goal", key: string, value: string, label: string): void => {
        written.push({ key, kind, value });
        if (!options.json) {
          io.stdout(`  + ${label} = ${value}\n`);
        }
      };
      for (const [key, value] of Object.entries(payload.facts ?? {})) {
        if (typeof value === "string" && value.length > 0) {
          await assembly.userMemoryStore.upsertFact(userKey, key, value);
          emitWrite("fact", key, value, `fact.${key}`);
        } else {
          skipped.push({ key, kind: "fact", reason: "empty or non-string value" });
        }
      }
      for (const [key, value] of Object.entries(payload.preferences ?? {})) {
        if (typeof value === "string" && value.length > 0) {
          await assembly.userMemoryStore.upsertPreference(userKey, key, value);
          emitWrite("preference", key, value, `pref.${key}`);
        } else {
          skipped.push({ key, kind: "preference", reason: "empty or non-string value" });
        }
      }
      for (const slot of payload.vetoes ?? []) {
        if (slot && typeof slot.value === "string" && slot.value.length > 0) {
          const key = `veto:${slot.id || slot.value.slice(0, 24)}`;
          await assembly.userMemoryStore.upsertPreference(userKey, key, slot.value);
          emitWrite("veto", key, slot.value, key);
        } else {
          skipped.push({ kind: "veto", reason: "empty or non-string value" });
        }
      }
      for (const slot of payload.goals ?? []) {
        if (slot && typeof slot.value === "string" && slot.value.length > 0) {
          const key = `goal:${slot.id || slot.value.slice(0, 24)}`;
          await assembly.userMemoryStore.upsertPreference(userKey, key, slot.value);
          emitWrite("goal", key, slot.value, key);
        } else {
          skipped.push({ kind: "goal", reason: "empty or non-string value" });
        }
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ skipped, userKey, written }, null, 2)}\n`);
      } else if (written.length === 0) {
        io.stdout("(model parsed the statement but found nothing new to remember — already in memory or content was not extractable)\n");
      } else {
        io.stdout(`Remembered ${written.length.toString()} item(s) under user '${userKey}'.\n`);
      }
    });

  program
    .command("forget")
    .description("Remove a fact/preference (`muse forget name`) or the whole persona (`muse forget --all --force`)")
    .addHelpText("after", `
Examples:
  $ muse forget home_city         # remove one fact/preference by key
  $ muse forget --all --force     # wipe the entire persona (destructive)`)
    .argument("[key]", "Fact or preference key to remove")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .option("--all", "Wipe the entire persona for the user — destructive, pair with --force")
    .option("--force", "Skip the interactive confirmation prompt (required with --all)")
    .action(async (key: string | undefined, options: ForgetOptions) => {
      const userKey = composeKey(options.user, options.persona);
      const assembly = createMuseRuntimeAssembly();
      const memory = await Promise.resolve(assembly.userMemoryStore.findByUserId(userKey));

      if (options.all) {
        if (!options.force) {
          io.stderr("--all is destructive. Re-run with --force to confirm.\n");
          process.exitCode = 1;
          return;
        }
        if (!memory) {
          io.stdout(`(nothing to forget — user '${userKey}' has no memory)\n`);
          return;
        }
        const dropped = await assembly.userMemoryStore.deleteByUserId(userKey);
        if (dropped) {
          io.stdout(`Forgot everything under user '${userKey}'.\n`);
        } else {
          io.stdout(`(no memory existed for user '${userKey}')\n`);
        }
        return;
      }

      if (!key) {
        io.stderr("usage: muse forget <key> | muse forget --all --force\n");
        process.exitCode = 1;
        return;
      }
      if (!memory) {
        io.stdout(`(no memory for user '${userKey}' — nothing to forget)\n`);
        return;
      }

      const factHit = memory.facts[key];
      const prefHit = memory.preferences[key];
      // Also tolerate the veto:/goal: prefix forms when the user types them.
      const vetoHit = memory.preferences[`veto:${key}`];
      const goalHit = memory.preferences[`goal:${key}`];

      if (factHit !== undefined) {
        // The store has no explicit deleteFact API, so rebuild the
        // memory by writing every other fact/pref back unchanged and
        // emit the missing one through a hand-rolled wipe.
        await rebuildWithout(assembly.userMemoryStore, userKey, memory, { factKey: key });
        io.stdout(`Forgot fact.${key} (was: ${factHit})\n`);
      } else if (prefHit !== undefined) {
        await rebuildWithout(assembly.userMemoryStore, userKey, memory, { prefKey: key });
        io.stdout(`Forgot pref.${key} (was: ${prefHit})\n`);
      } else if (vetoHit !== undefined) {
        await rebuildWithout(assembly.userMemoryStore, userKey, memory, { prefKey: `veto:${key}` });
        io.stdout(`Forgot veto.${key} (was: ${vetoHit})\n`);
      } else if (goalHit !== undefined) {
        await rebuildWithout(assembly.userMemoryStore, userKey, memory, { prefKey: `goal:${key}` });
        io.stdout(`Forgot goal.${key} (was: ${goalHit})\n`);
      } else {
        io.stdout(`(key '${key}' not in memory for user '${userKey}')\n`);
      }
    });
}

/**
 * UserMemoryStore exposes upsertFact / upsertPreference / deleteByUserId
 * but not "delete one fact". Emulate by wiping the user then re-upserting
 * everything except the targeted key. Atomic from the FileUserMemoryStore
 * tmp+rename writer's perspective — the partial state never lands on disk.
 */
async function rebuildWithout(
  store: ReturnType<typeof createMuseRuntimeAssembly>["userMemoryStore"],
  userKey: string,
  memory: { readonly facts: Readonly<Record<string, string>>; readonly preferences: Readonly<Record<string, string>> },
  drop: { readonly factKey?: string; readonly prefKey?: string }
): Promise<void> {
  await store.deleteByUserId(userKey);
  for (const [key, value] of Object.entries(memory.facts)) {
    if (drop.factKey === key) continue;
    await store.upsertFact(userKey, key, value);
  }
  for (const [key, value] of Object.entries(memory.preferences)) {
    if (drop.prefKey === key) continue;
    await store.upsertPreference(userKey, key, value);
  }
}
