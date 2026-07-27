import { resolve } from "node:path";

import { Command, InvalidArgumentError } from "commander";

import type { ProgramIO } from "./program.js";
import { setCliTerminalState } from "./cli-terminal-state.js";
import {
  DEFAULT_CAPABILITY_EVIDENCE_MAX_AGE_HOURS,
  qualifyPersonalAgent,
  type PersonalAgentQualificationObservations,
  type PersonalAgentQualificationReport
} from "./personal-agent-qualification.js";
import {
  collectPersonalAgentQualificationObservations,
  type CollectQualificationOptions
} from "./personal-agent-qualification-probes.js";
import { discoverRepoRoot } from "./commands-update.js";

export interface QualifyCommandDependencies {
  readonly collect?: (options: CollectQualificationOptions) => Promise<PersonalAgentQualificationObservations>;
  readonly workspaceDir?: string;
}

function parseMaxEvidenceAgeHours(value: string): number {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > DEFAULT_CAPABILITY_EVIDENCE_MAX_AGE_HOURS) {
    throw new InvalidArgumentError(
      `must be greater than 0 and at most ${DEFAULT_CAPABILITY_EVIDENCE_MAX_AGE_HOURS.toString()}`
    );
  }
  return hours;
}

export function renderPersonalAgentQualification(report: PersonalAgentQualificationReport): string {
  const headline = report.status === "qualified"
    ? "QUALIFIED"
    : report.status === "not-qualified" ? "NOT QUALIFIED" : "UNVERIFIED";
  const lines = [`Muse personal-agent qualification: ${headline}`];
  for (const gate of report.gates) {
    const reasons = gate.reasonCodes.length > 0 ? ` — ${gate.reasonCodes.join(", ")}` : "";
    lines.push(`  ${gate.id}: ${gate.status.toUpperCase()}${reasons}`);
  }
  lines.push("  organic-effectiveness: NOT PROVEN — organic-personal-effectiveness-not-proven");
  return `${lines.join("\n")}\n`;
}

export function resolveQualificationWorkspaceDir(input: {
  readonly cwd: string;
  readonly entryFile: string | undefined;
  readonly initCwd: string | undefined;
  readonly ioWorkspaceDir: string | undefined;
}): string {
  return resolve(
    discoverRepoRoot(input.entryFile)
    ?? input.initCwd
    ?? input.ioWorkspaceDir
    ?? input.cwd
  );
}

function defaultWorkspaceDir(io: ProgramIO): string {
  return resolveQualificationWorkspaceDir({
    cwd: process.cwd(),
    entryFile: process.argv[1],
    initCwd: process.env.INIT_CWD,
    ioWorkspaceDir: io.workspaceDir
  });
}

export function registerQualifyCommand(
  program: Command,
  io: ProgramIO,
  dependencies: QualifyCommandDependencies = {}
): void {
  program
    .command("qualify")
    .description("Read-only, fail-closed personal-agent qualification (capability, runtime, delivery safety)")
    .option("--json", "Print the privacy-safe machine-readable report")
    .option("--capability-report <path>", "Read capability evidence from this report file")
    .option(
      "--max-evidence-age-hours <hours>",
      `Require capability evidence no older than this (maximum ${DEFAULT_CAPABILITY_EVIDENCE_MAX_AGE_HOURS.toString()})`,
      parseMaxEvidenceAgeHours
    )
    .action(async (options: {
      readonly json?: boolean;
      readonly capabilityReport?: string;
      readonly maxEvidenceAgeHours?: number;
    }) => {
      const observations = await (dependencies.collect ?? collectPersonalAgentQualificationObservations)({
        workspaceDir: resolve(dependencies.workspaceDir ?? defaultWorkspaceDir(io)),
        ...(options.capabilityReport ? { capabilityReportFile: resolve(options.capabilityReport) } : {}),
        ...(options.maxEvidenceAgeHours !== undefined ? { maxEvidenceAgeHours: options.maxEvidenceAgeHours } : {})
      });
      const report = qualifyPersonalAgent(observations);
      io.stdout(options.json ? `${JSON.stringify(report)}\n` : renderPersonalAgentQualification(report));
      setCliTerminalState(
        report.status === "qualified"
          ? "success"
          : report.status === "unverified" ? "unverified" : "internal-failure"
      );
    });
}
