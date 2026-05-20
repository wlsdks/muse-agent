/**
 * `runChatRepl` slash-command dispatcher, lifted out of
 * `chat-repl.ts` so the main REPL function stays focused on the
 * read-line loop + the streaming-turn path.
 *
 * The handler reads and mutates ~7 state slots that live inside
 * `runChatRepl`'s closure. We flow those through a `SlashContext`
 * (mutable object whose fields the handler writes back to) plus
 * a `SlashDeps` (immutable references — registries, helpers, the
 * runtime assembly). Caller observes the mutations directly on
 * the ctx object after the call returns.
 *
 * Pure refactor — every command body lifted verbatim, just
 * s/local var/ctx.X/. Existing CLI tests cover all the slash
 * paths and keep this honest.
 */

import { clearLastChatHistory } from "./chat-history.js";
import { closestCommandName } from "./closest-command.js";
import { consumeAskStream, type AskStreamEvent } from "./commands-ask.js";
import type { ProgramIO } from "./program.js";

const SLASH_COMMANDS = [
  "exit",
  "quit",
  "reset",
  "history",
  "model",
  "tools",
  "fact",
  "pref",
  "whoami",
  "persona",
  "trust",
  "remember",
  "forget",
  "help"
] as const;

export interface ChatTurnRecord {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface SlashContext {
  active: boolean;
  currentPersona: string | undefined;
  currentModel: string | undefined;
  userId: string;
  userMemory: UserMemorySnapshot | undefined;
  trust: TrustRecord;
  toolsDisabled: boolean;
  history: ChatTurnRecord[];
}

export interface UserMemorySnapshot {
  readonly facts: Readonly<Record<string, string>>;
  readonly preferences: Readonly<Record<string, string>>;
  readonly recentTopics: readonly string[];
}

/** Matches the `TrustEntry` shape returned by `commands-trust.readTrust`. */
export interface TrustRecord {
  readonly trustedTools: string[];
  readonly blockedTools: string[];
}

export interface SlashUserMemoryStore {
  findByUserId(userId: string): Promise<UserMemorySnapshot | undefined> | UserMemorySnapshot | undefined;
  upsertFact(userId: string, key: string, value: string): Promise<unknown> | unknown;
  upsertPreference(userId: string, key: string, value: string): Promise<unknown> | unknown;
  deleteByUserId(userId: string): Promise<boolean> | boolean;
}

export interface SlashAutoExtract {
  pickSystemPrompt: (text: string) => string;
  extractJsonObject: (raw: string) => SlashRememberPayload | undefined;
}

export interface SlashRememberPayload {
  readonly facts?: Readonly<Record<string, string>>;
  readonly preferences?: Readonly<Record<string, string>>;
  readonly vetoes?: readonly { readonly id?: string; readonly value: string }[];
  readonly goals?: readonly { readonly id?: string; readonly value: string }[];
}

export interface SlashAssembly {
  readonly defaultModel?: string;
  readonly modelProvider?: {
    stream(request: {
      readonly model: string;
      readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
    }): AsyncIterable<{ readonly type: string; readonly text?: string }>;
  };
}

export interface SlashDeps {
  readonly memoryStore: SlashUserMemoryStore | undefined;
  readonly autoExtract: SlashAutoExtract | undefined;
  readonly assembly: SlashAssembly;
  readonly readTrust: (userId: string) => Promise<TrustRecord>;
  readonly composeUserKey: () => string;
}

export async function handleSlashCommand(
  cmd: string | undefined,
  arg: string,
  ctx: SlashContext,
  deps: SlashDeps,
  io: ProgramIO
): Promise<void> {
  switch (cmd) {
    case "exit":
    case "quit":
      io.stdout("(bye)\n");
      ctx.active = false;
      return;
    case "reset":
      ctx.history.length = 0;
      await clearLastChatHistory();
      io.stdout("(history cleared)\n");
      return;
    case "history":
      io.stdout(`(${ctx.history.length.toString()} turns in context)\n`);
      return;
    case "model":
      if (arg.length === 0) {
        io.stdout(`(current model: ${ctx.currentModel ?? "(default)"})\n`);
      } else {
        ctx.currentModel = arg;
        io.stdout(`(model → ${arg})\n`);
      }
      return;
    case "tools": {
      const normalised = arg.trim().toLowerCase();
      if (normalised === "on") {
        ctx.toolsDisabled = false;
        io.stdout("(tools on)\n");
      } else if (normalised === "off") {
        ctx.toolsDisabled = true;
        io.stdout("(tools off — chat-only fast path)\n");
      } else {
        io.stdout(`(tools currently ${ctx.toolsDisabled ? "off" : "on"}; usage: /tools on|off)\n`);
      }
      return;
    }
    case "fact":
    case "pref": {
      const eq = arg.indexOf("=");
      if (eq < 0 || !deps.memoryStore) {
        io.stdout(`(usage: /${cmd} <key>=<value>${deps.memoryStore ? "" : "; no user-memory store available"})\n`);
        return;
      }
      const key = arg.slice(0, eq).trim();
      const value = arg.slice(eq + 1).trim();
      if (key.length === 0 || value.length === 0) {
        io.stdout(`(usage: /${cmd} <key>=<value>)\n`);
        return;
      }
      await Promise.resolve(
        cmd === "fact"
          ? deps.memoryStore.upsertFact(ctx.userId, key, value)
          : deps.memoryStore.upsertPreference(ctx.userId, key, value)
      );
      ctx.userMemory = await Promise.resolve(deps.memoryStore.findByUserId(ctx.userId));
      io.stdout(`(remembered ${cmd}.${key}=${value})\n`);
      return;
    }
    case "whoami":
      if (!ctx.userMemory) {
        io.stdout(`(no memory for user '${ctx.userId}' yet — try /fact name=YourName)\n`);
      } else {
        io.stdout(`user: ${ctx.userId}\n`);
        for (const [key, value] of Object.entries(ctx.userMemory.facts)) {
          io.stdout(`  fact.${key}: ${value}\n`);
        }
        for (const [key, value] of Object.entries(ctx.userMemory.preferences)) {
          io.stdout(`  pref.${key}: ${value}\n`);
        }
      }
      return;
    case "persona":
      if (arg.length === 0) {
        io.stdout(`(current persona: ${ctx.currentPersona ?? "(none — base profile)"}; usage: /persona work | /persona home | /persona none)\n`);
      } else {
        const sentinel = arg.trim().toLowerCase();
        const next = sentinel === "none" || sentinel === "off" || sentinel === "default" ? undefined : arg;
        ctx.currentPersona = next;
        ctx.userId = deps.composeUserKey();
        ctx.userMemory = deps.memoryStore ? await Promise.resolve(deps.memoryStore.findByUserId(ctx.userId)) : undefined;
        ctx.trust = await deps.readTrust(ctx.userId).catch(() => ({ blockedTools: [] as string[], trustedTools: [] as string[] }));
        io.stdout(`(persona → ${ctx.currentPersona ?? "(base)"}; userKey=${ctx.userId})\n`);
        if (ctx.userMemory) {
          const factCount = Object.keys(ctx.userMemory.facts).length;
          const prefCount = Object.keys(ctx.userMemory.preferences).length;
          io.stdout(`  remembered: ${factCount.toString()} fact(s), ${prefCount.toString()} pref(s) for this persona\n`);
        } else {
          io.stdout(`  (no memory for this persona yet — start fresh)\n`);
        }
      }
      return;
    case "trust":
      io.stdout(`  trust for ${ctx.userId}:\n`);
      io.stdout(`    + trusted (${ctx.trust.trustedTools.length.toString()}): ${ctx.trust.trustedTools.join(", ") || "(none)"}\n`);
      io.stdout(`    × blocked (${ctx.trust.blockedTools.length.toString()}): ${ctx.trust.blockedTools.join(", ") || "(none)"}\n`);
      return;
    case "remember": {
      // Natural-language LLM extraction → upsert into memory.
      // Mirrors the top-level `muse remember` command but works
      // in-REPL so the user can teach JARVIS mid-conversation.
      if (arg.length === 0 || !deps.assembly.modelProvider) {
        io.stdout(`(usage: /remember <text>; requires a configured model)\n`);
        return;
      }
      try {
        const sysPrompt = deps.autoExtract?.pickSystemPrompt(arg) ?? "Extract user facts as JSON.";
        const { answer: raw, error: streamError } = await consumeAskStream(
          deps.assembly.modelProvider.stream({
            messages: [
              { content: sysPrompt, role: "system" },
              { content: `User turn:\n${arg}\n\nAssistant reply:\n(no reply — extract from the statement)`, role: "user" }
            ],
            model: ctx.currentModel ?? deps.assembly.defaultModel ?? "default"
          }) as AsyncIterable<AskStreamEvent>,
          () => {},
          () => false
        );
        if (streamError !== undefined) {
          io.stdout(`(error: ${streamError})\n`);
          return;
        }
        const payload = deps.autoExtract?.extractJsonObject(raw);
        if (!payload || !deps.memoryStore) {
          io.stdout("(nothing extracted — try rephrasing)\n");
          return;
        }
        let wrote = 0;
        for (const [k, v] of Object.entries(payload.facts ?? {})) {
          if (typeof v === "string" && v.length > 0) {
            await Promise.resolve(deps.memoryStore.upsertFact(ctx.userId, k, v));
            io.stdout(`  + fact.${k} = ${v}\n`);
            wrote += 1;
          }
        }
        for (const [k, v] of Object.entries(payload.preferences ?? {})) {
          if (typeof v === "string" && v.length > 0) {
            await Promise.resolve(deps.memoryStore.upsertPreference(ctx.userId, k, v));
            io.stdout(`  + pref.${k} = ${v}\n`);
            wrote += 1;
          }
        }
        for (const slot of payload.vetoes ?? []) {
          if (slot && typeof slot.value === "string" && slot.value.length > 0) {
            const k = `veto:${slot.id || slot.value.slice(0, 24)}`;
            await Promise.resolve(deps.memoryStore.upsertPreference(ctx.userId, k, slot.value));
            io.stdout(`  + ${k} = ${slot.value}\n`);
            wrote += 1;
          }
        }
        for (const slot of payload.goals ?? []) {
          if (slot && typeof slot.value === "string" && slot.value.length > 0) {
            const k = `goal:${slot.id || slot.value.slice(0, 24)}`;
            await Promise.resolve(deps.memoryStore.upsertPreference(ctx.userId, k, slot.value));
            io.stdout(`  + ${k} = ${slot.value}\n`);
            wrote += 1;
          }
        }
        ctx.userMemory = await Promise.resolve(deps.memoryStore.findByUserId(ctx.userId));
        io.stdout(`(remembered ${wrote.toString()} item(s))\n`);
      } catch (cause) {
        io.stderr(`(/remember failed: ${cause instanceof Error ? cause.message : String(cause)})\n`);
      }
      return;
    }
    case "forget": {
      if (arg.length === 0 || !deps.memoryStore) {
        io.stdout(`(usage: /forget <key> | /forget --all)\n`);
        return;
      }
      if (arg === "--all" || arg === "all") {
        const dropped = await Promise.resolve(deps.memoryStore.deleteByUserId(ctx.userId));
        ctx.userMemory = undefined;
        io.stdout(dropped ? `(wiped all memory for ${ctx.userId})\n` : `(no memory to wipe)\n`);
        return;
      }
      const k = arg;
      if (!ctx.userMemory) {
        io.stdout(`(no memory for ${ctx.userId})\n`);
        return;
      }
      const factHit = ctx.userMemory.facts[k];
      const prefHit = ctx.userMemory.preferences[k] ?? ctx.userMemory.preferences[`veto:${k}`] ?? ctx.userMemory.preferences[`goal:${k}`];
      if (factHit === undefined && prefHit === undefined) {
        io.stdout(`(key '${k}' not in memory)\n`);
        return;
      }
      // Wipe + rebuild-without (mirrors top-level forget).
      const snapshot = ctx.userMemory;
      await Promise.resolve(deps.memoryStore.deleteByUserId(ctx.userId));
      for (const [fk, fv] of Object.entries(snapshot.facts)) {
        if (fk !== k) await Promise.resolve(deps.memoryStore.upsertFact(ctx.userId, fk, fv));
      }
      for (const [pk, pv] of Object.entries(snapshot.preferences)) {
        if (pk === k || pk === `veto:${k}` || pk === `goal:${k}`) continue;
        await Promise.resolve(deps.memoryStore.upsertPreference(ctx.userId, pk, pv));
      }
      ctx.userMemory = await Promise.resolve(deps.memoryStore.findByUserId(ctx.userId));
      io.stdout(`(forgot ${k})\n`);
      return;
    }
    case "help":
      io.stdout("  /exit, /quit          leave\n");
      io.stdout("  /reset                clear history (both memory + disk)\n");
      io.stdout("  /history              show turn count\n");
      io.stdout("  /model <tag>          switch model (e.g. ollama/qwen2.5:7b-instruct)\n");
      io.stdout("  /tools on|off         toggle tool registry\n");
      io.stdout("  /fact key=value       remember a fact about you (persists across sessions)\n");
      io.stdout("  /pref key=value       remember a preference\n");
      io.stdout("  /whoami               show what Muse knows about you\n");
      io.stdout("  /persona <slot>       switch persona slot (work / home / none); each has its own memory\n");
      io.stdout("  /trust                show this user's trusted + blocked tools\n");
      io.stdout("  /remember <text>      LLM-extract facts/prefs/vetoes/goals from natural language\n");
      io.stdout("  /forget <key>         drop a single fact/pref; /forget --all wipes the persona\n");
      io.stdout("  /help                 this list\n");
      return;
    default: {
      const typed = cmd ?? "";
      const suggestion = typed.length > 0 ? closestCommandName(typed, SLASH_COMMANDS) : undefined;
      if (suggestion) {
        io.stdout(`(unknown command: /${typed} — did you mean /${suggestion}? try /help for the list)\n`);
      } else {
        io.stdout(`(unknown command: /${typed} — try /help)\n`);
      }
    }
  }
}
