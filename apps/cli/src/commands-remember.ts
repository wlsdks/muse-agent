/**
 * `muse remember <text>` / `muse forget --all --force` — natural-language
 * memory tweaks. Two top-level shortcuts so the user can train
 * JARVIS in one line from anywhere (shell aliases, scripts, voice
 * loop, ad-hoc commands) without entering the REPL.
 *
 * `muse remember "I prefer concise English replies"`
 *   → runs the auto-extract prompt against the local model
 *   → writes facts/prefs/vetoes/goals into ~/.muse/user-memory.json
 *
 * Single-entry deletion lives under `muse memory inspect|preview|forget|undo`
 * so a display key can never become fuzzy deletion authority.
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
import { readNonEmptyEnv } from "./env.js";
import { resolvePersona } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";
import { reportNoModelConfigured } from "./no-model-message.js";

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
  return readNonEmptyEnv(process.env, key);
}

export function composeKey(user: string | undefined, persona: string | undefined): string {
  const base = user ?? envValue("MUSE_USER_ID") ?? envValue("USER") ?? "default";
  const resolved = resolvePersona(persona);
  return resolved ? `${base}@${resolved}` : base;
}

export function registerRememberCommands(program: Command, io: ProgramIO): void {
  program
    .command("remember")
    .description("Tell Muse something in natural language — it extracts facts/prefs/vetoes/goals into ~/.muse/user-memory.json")
    .addHelpText("after", `
Examples:
  $ muse remember "I'm vegetarian and I hate 8am meetings"   # extracts facts/prefs/goals
  $ muse remember --json "my timezone is KST"                # structured {written,skipped} output
  $ muse memory inspect                                      # exact-ID correction/deletion starts here`)
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
        await reportNoModelConfigured(io, process.env, "remember");
        io.stderr(
          "  Or use the no-LLM direct path:\n"
          + `  muse memory set --local --user ${userKey} fact <key> "<value>"\n`
          + `  muse memory set --local --user ${userKey} preference <key> "<value>"\n`
        );
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
      const createMemory = async (kind: "fact" | "preference", key: string, value: string): Promise<boolean> => {
        const result = kind === "fact"
          ? await assembly.userMemoryStore.createFactIfAbsent(userKey, key, value)
          : await assembly.userMemoryStore.createPreferenceIfAbsent(userKey, key, value);
        if (result.created) return true;
        skipped.push({
          key,
          kind,
          reason: result.existingValue === value
            ? "already stored"
            : "existing memory requires exact-ID correction via `muse memory inspect` + `muse memory correct`"
        });
        return false;
      };
      const emitWrite = (kind: "fact" | "preference" | "veto" | "goal", key: string, value: string, label: string): void => {
        written.push({ key, kind, value });
        if (!options.json) {
          io.stdout(`  + ${label} = ${value}\n`);
        }
      };
      for (const [key, value] of Object.entries(payload.facts ?? {})) {
        if (typeof value === "string" && value.length > 0) {
          if (!await createMemory("fact", key, value)) continue;
          emitWrite("fact", key, value, `fact.${key}`);
        } else {
          skipped.push({ key, kind: "fact", reason: "empty or non-string value" });
        }
      }
      for (const [key, value] of Object.entries(payload.preferences ?? {})) {
        if (typeof value === "string" && value.length > 0) {
          if (!await createMemory("preference", key, value)) continue;
          emitWrite("preference", key, value, `pref.${key}`);
        } else {
          skipped.push({ key, kind: "preference", reason: "empty or non-string value" });
        }
      }
      for (const slot of payload.vetoes ?? []) {
        if (slot && typeof slot.value === "string" && slot.value.length > 0) {
          const key = `veto:${slot.id || slot.value.slice(0, 24)}`;
          if (!await createMemory("preference", key, slot.value)) continue;
          emitWrite("veto", key, slot.value, key);
        } else {
          skipped.push({ kind: "veto", reason: "empty or non-string value" });
        }
      }
      for (const slot of payload.goals ?? []) {
        if (slot && typeof slot.value === "string" && slot.value.length > 0) {
          const key = `goal:${slot.id || slot.value.slice(0, 24)}`;
          if (!await createMemory("preference", key, slot.value)) continue;
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
    .description("Wipe the whole persona; use `muse memory forget` for one exact, undoable entry")
    .addHelpText("after", `
Examples:
  $ muse memory inspect           # obtain exact entry IDs and versions
  $ muse memory forget mem_v1_… --expected-version 1 --confirm mem_v1_…
  $ muse forget --all --force     # wipe the entire persona (destructive)`)
    .argument("[key]", "Deprecated display key; single-entry fuzzy deletion is refused")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .option("--all", "Wipe the entire persona for the user — destructive, pair with --force")
    .option("--force", "Skip the interactive confirmation prompt (required with --all)")
    .action(async (key: string | undefined, options: ForgetOptions) => {
      const userKey = composeKey(options.user, options.persona);
      const assembly = createMuseRuntimeAssembly();
      const memory = await assembly.userMemoryStore.findByUserId(userKey);

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
        io.stderr("usage: muse memory inspect | muse forget --all --force\n");
        process.exitCode = 1;
        return;
      }
      io.stderr(
        "Single-entry deletion by display key is no longer allowed. "
        + "Run `muse memory inspect`, preview the exact ID, then use "
        + "`muse memory forget <exact-id> --expected-version <n> --confirm <exact-id>`.\n"
      );
      process.exitCode = 2;
    });
}
