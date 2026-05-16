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
    .command("use")
    .description("Flip the active persona by id (built-in or custom)")
    .argument("<id>", "Persona id")
    .action(async (id: string) => {
      const trimmed = id.trim();
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
      await writePersonaStore(file, { ...store, activeId: trimmed });
      io.stdout(`active persona → ${trimmed}\n`);
    });

  persona
    .command("show")
    .description("Print the active persona's preamble")
    .option("--json", "Emit a structured payload")
    .action(async (options: { readonly json?: boolean }) => {
      const file = defaultPersonaFile();
      const store = await readPersonaStore(file);
      const preamble = resolveActivePersonaPreamble(store);
      if (options.json) {
        io.stdout(`${JSON.stringify({ activeId: store.activeId, preamble }, null, 2)}\n`);
        return;
      }
      io.stdout(`active: ${store.activeId}\n\n`);
      if (preamble.length > 0) {
        io.stdout(`${preamble}\n`);
      } else if (personaIdIsKnown(store, store.activeId)) {
        io.stdout(`(no preamble — '${store.activeId}' contributes no persona text; the user's persona memory carries the tone)\n`);
      } else {
        io.stderr(`(active persona '${store.activeId}' is unknown — not a built-in or custom id; it resolves to no preamble. Run \`muse persona list\`.)\n`);
      }
    });
}
