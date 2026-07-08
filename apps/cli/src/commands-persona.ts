/**
 * `muse persona list / use / show` — system-prompt persona
 * templates.
 */

import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import {
  BUILTIN_PERSONAS,
  defaultPersonaFile,
  isBuiltinPersonaId,
  personaIdIsKnown,
  readPersonaStore,
  resolveActivePersonaPreamble,
  writePersonaStore
} from "./persona-store.js";
import { readPipedStdin } from "./chat-repl.js";
import type { ProgramIO } from "./program.js";

export function registerPersonaCommand(program: Command, io: ProgramIO): void {
  const persona = program.command("persona").description("System-prompt persona templates");

  persona
    .command("list")
    .description("List built-in + user-defined personas + the active id")
    .option("--json", "Emit a structured payload")
    .action(async (options: { readonly json?: boolean }) => {
      const file = defaultPersonaFile();
      const store = await readPersonaStore(file);
      const builtins = BUILTIN_PERSONAS.map((p) => ({
        id: p.id, description: p.description, source: "builtin" as const
      }));
      const customs = Object.entries(store.custom).map(([id, value]) => ({
        id, description: value.preamble.slice(0, 80), source: "custom" as const
      }));
      const personas = [...builtins, ...customs];
      if (options.json) {
        io.stdout(`${JSON.stringify({ activeId: store.activeId, personas }, null, 2)}\n`);
        return;
      }
      io.stdout(`active: ${store.activeId}\n\n`);
      for (const entry of personas) {
        const marker = entry.id === store.activeId ? "*" : " ";
        io.stdout(` ${marker} ${entry.id.padEnd(16)} [${entry.source}]  ${entry.description}\n`);
      }
      if (!personaIdIsKnown(store, store.activeId)) {
        io.stderr(`note: active persona '${store.activeId}' is unknown — not built-in, no custom entry — so it resolves to no preamble. \`muse persona use <id>\` to pick one of the above.\n`);
      }
    });

  persona
    .command("add")
    .description("Register a custom persona (id + preamble text or piped stdin). Run `muse persona use <id>` to activate.")
    .argument("<id>", "Custom persona id (must not collide with a built-in)")
    .argument("[preamble...]", "Preamble text the model prepends on every turn (omit to read from stdin)")
    .option("--json", "Emit a structured payload instead of the human-readable confirmation")
    .action(async (id: string, preambleParts: readonly string[], options: { readonly json?: boolean }) => {
      const trimmedId = id.trim();
      if (trimmedId.length === 0) {
        io.stderr("muse persona add: <id> must not be empty\n");
        process.exitCode = 1;
        return;
      }
      if (isBuiltinPersonaId(trimmedId)) {
        io.stderr(`muse persona add: '${trimmedId}' is a built-in id — pick a different id (e.g. '${trimmedId}-mine')\n`);
        process.exitCode = 1;
        return;
      }
      // Positional args win; fall back to piped stdin so a long
      // multi-paragraph preamble can be `cat preamble.txt | muse
      // persona add tony` instead of typed inline with shell
      // escaping. Same idiom as `muse ask`.
      let preamble = preambleParts.join(" ").trim();
      if (preamble.length === 0) {
        const piped = await (io.readPipedStdin ?? readPipedStdin)();
        preamble = piped.trim();
      }
      if (preamble.length === 0) {
        io.stderr("muse persona add: <preamble> must not be empty (pass it as an argument or pipe via stdin: `cat preamble.txt | muse persona add <id>`)\n");
        process.exitCode = 1;
        return;
      }
      const file = defaultPersonaFile();
      const store = await readPersonaStore(file);
      const replacing = Object.hasOwn(store.custom, trimmedId);
      const nextCustom: Record<string, { preamble: string }> = { ...store.custom, [trimmedId]: { preamble } };
      await writePersonaStore(file, { ...store, custom: nextCustom });
      const action = replacing ? "updated" : "added";
      if (options.json) {
        io.stdout(`${JSON.stringify({ action, id: trimmedId }, null, 2)}\n`);
        return;
      }
      io.stdout(`${replacing ? "Updated" : "Added"} custom persona ${trimmedId}\n`);
    });

  persona
    .command("use")
    .description("Flip the active persona by id (built-in or custom)")
    .argument("<id>", "Persona id")
    .option("--json", "Emit a structured payload instead of the arrow confirmation")
    .action(async (id: string, options: { readonly json?: boolean }) => {
      const trimmed = id.trim();
      // Mirrors `muse persona remove` / `muse persona add` empty-id
      // guard so a `$VAR`-empty shell expansion surfaces a clear
      // message instead of the auto-generated `no persona with id ''`
      // that the lookup path produces below.
      if (trimmed.length === 0) {
        io.stderr("muse persona use: <id> must not be empty\n");
        process.exitCode = 1;
        return;
      }
      const file = defaultPersonaFile();
      const store = await readPersonaStore(file);
      const exists = isBuiltinPersonaId(trimmed) || Object.hasOwn(store.custom, trimmed);
      if (!exists) {
        const candidates = [
          ...BUILTIN_PERSONAS.map((p) => p.id),
          ...Object.keys(store.custom)
        ];
        const suggestion = closestCommandName(trimmed, candidates);
        io.stderr(`muse persona use: no persona with id '${trimmed}'`);
        if (suggestion) io.stderr(` — did you mean '${suggestion}'?`);
        io.stderr(` (run \`muse persona list\` to see the options)\n`);
        process.exitCode = 1;
        return;
      }
      const previousActiveId = store.activeId;
      await writePersonaStore(file, { ...store, activeId: trimmed });
      if (options.json) {
        io.stdout(`${JSON.stringify({ activeId: trimmed, previousActiveId }, null, 2)}\n`);
        return;
      }
      io.stdout(`active persona → ${trimmed}\n`);
    });

  persona
    .command("remove")
    .description("Delete a custom persona by id (built-ins cannot be removed)")
    .argument("<id>", "Custom persona id")
    .option("--json", "Emit a structured payload instead of the human-readable confirmation")
    .action(async (id: string, options: { readonly json?: boolean }) => {
      const trimmed = id.trim();
      if (trimmed.length === 0) {
        io.stderr("muse persona remove: <id> must not be empty\n");
        process.exitCode = 1;
        return;
      }
      if (isBuiltinPersonaId(trimmed)) {
        io.stderr(`muse persona remove: '${trimmed}' is a built-in — built-ins cannot be removed (run \`muse persona list\` for the custom ids)\n`);
        process.exitCode = 1;
        return;
      }
      const file = defaultPersonaFile();
      const store = await readPersonaStore(file);
      if (!Object.hasOwn(store.custom, trimmed)) {
        const suggestion = closestCommandName(trimmed, Object.keys(store.custom));
        io.stderr(`muse persona remove: no custom persona with id '${trimmed}'`);
        if (suggestion) io.stderr(` — did you mean '${suggestion}'?`);
        io.stderr(` (run \`muse persona list\` to see the custom ids)\n`);
        process.exitCode = 1;
        return;
      }
      const nextCustom: Record<string, { preamble: string }> = {};
      for (const [key, value] of Object.entries(store.custom)) {
        if (key !== trimmed) nextCustom[key] = value;
      }
      const wasActive = store.activeId === trimmed;
      const nextActiveId = wasActive ? "default" : store.activeId;
      await writePersonaStore(file, { activeId: nextActiveId, custom: nextCustom });
      if (options.json) {
        io.stdout(`${JSON.stringify({ id: trimmed, resetActive: wasActive, activeId: nextActiveId }, null, 2)}\n`);
        return;
      }
      io.stdout(`Removed custom persona ${trimmed}${wasActive ? " (active persona reset to default)" : ""}\n`);
    });

  persona
    .command("show")
    .description("Print the active persona's preamble (or `--id <id>` to preview any registered persona without activating it)")
    .option("--id <id>", "Preview this persona instead of the active one — does not switch active")
    .option("--json", "Emit a structured payload")
    .action(async (options: { readonly id?: string; readonly json?: boolean }) => {
      const file = defaultPersonaFile();
      const store = await readPersonaStore(file);
      const requested = options.id?.trim();
      const previewing = requested !== undefined && requested.length > 0;
      if (previewing && !personaIdIsKnown(store, requested)) {
        const candidates = [
          ...BUILTIN_PERSONAS.map((p) => p.id),
          ...Object.keys(store.custom)
        ];
        const suggestion = closestCommandName(requested, candidates);
        io.stderr(`muse persona show: no persona with id '${requested}'`);
        if (suggestion) io.stderr(` — did you mean '${suggestion}'?`);
        io.stderr(` (run \`muse persona list\` to see the options)\n`);
        process.exitCode = 1;
        return;
      }
      const targetId = previewing ? requested : store.activeId;
      // Preview uses the same precedence as the active resolver:
      // custom override wins over built-in.
      const preview = previewing
        ? (Object.hasOwn(store.custom, targetId) && store.custom[targetId]!.preamble.length > 0
          ? store.custom[targetId]!.preamble
          : (BUILTIN_PERSONAS.find((p) => p.id === targetId)?.preamble ?? ""))
        : resolveActivePersonaPreamble(store);
      const preamble = preview;
      if (options.json) {
        io.stdout(`${JSON.stringify({
          activeId: store.activeId,
          ...(previewing ? { previewingId: targetId } : {}),
          preamble
        }, null, 2)}\n`);
        return;
      }
      const label = previewing ? `preview: ${targetId} (active is ${store.activeId})` : `active: ${targetId}`;
      io.stdout(`${label}\n\n`);
      if (preamble.length > 0) {
        io.stdout(`${preamble}\n`);
      } else if (personaIdIsKnown(store, targetId)) {
        io.stdout(`(no preamble — '${targetId}' contributes no persona text; the user's persona memory carries the tone)\n`);
      } else {
        io.stderr(`(active persona '${targetId}' is unknown — not a built-in or custom id; it resolves to no preamble. Run \`muse persona list\`.)\n`);
      }
    });
}
