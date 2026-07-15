/**
 * `muse features` — surfaces the hidden default-OFF feature gates from
 * `FEATURE_REGISTRY` so a user can discover a capability they never knew
 * existed, and see the exact env var + enable line to turn it on. Read-only:
 * reads `process.env`, prints, mutates nothing.
 */

import type { Command } from "commander";

import { evaluateFeatures, type FeatureStatus } from "./feature-registry.js";
import type { ProgramIO } from "./program.js";

export function renderFeatures(statuses: readonly FeatureStatus[]): string {
  const lines: string[] = ["🔧 Muse features — capabilities that ship OFF by default:", ""];
  for (const { entry, enabled } of statuses) {
    if (enabled) {
      lines.push(`  ✅ ${entry.title} — ON (enabled in current environment)`);
    } else {
      lines.push(`  ▫️  ${entry.title} — OFF`);
      lines.push(`      unlocks: ${entry.unlocks}`);
      lines.push(`      enable:  ${entry.enableHint}`);
      for (const prerequisite of entry.prerequisites ?? []) {
        lines.push(`      note:    ${prerequisite}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function registerFeaturesCommand(program: Command, io: ProgramIO): void {
  program
    .command("features")
    .description("Discover hidden capabilities that ship OFF by default, with the exact env var to enable each")
    .option("--json", "Emit the feature statuses as JSON")
    .action((options: { readonly json?: boolean }) => {
      const statuses = evaluateFeatures(process.env);
      if (options.json) {
        io.stdout(`${JSON.stringify(statuses, null, 2)}\n`);
        return;
      }
      io.stdout(renderFeatures(statuses));
    });
}
