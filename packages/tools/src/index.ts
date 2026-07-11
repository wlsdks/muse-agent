import type { ModelTool } from "@muse/model";
import type { SanitizedToolOutput } from "@muse/policy";
import type { JsonObject, JsonValue } from "@muse/shared";

import { toModelTool } from "./tool-definition-helpers.js";
import {
  createDefaultToolExposurePolicy,
  createWorkspaceToolRoutingPlan,
  type ToolExposureContext,
  type ToolExposurePolicy,
  type ToolExposureScope,
  type ToolExposureSelection,
  type WorkspaceToolRoutingPlan
} from "./tool-exposure-policy.js";

export type ToolRisk = "read" | "write" | "execute";
export type ToolExecutionStatus = "completed" | "blocked" | "failed";

export interface MuseToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly risk: ToolRisk;
  readonly dependsOn?: readonly string[];
  readonly keywords?: readonly string[];
  readonly scopes?: readonly ToolExposureScope[];
  /**
   * Context Engineering Phase 4: feature domain tag used by
   * `DefaultToolFilter` to filter the tool catalog by user-prompt
   * keywords. Suggested values:
   *   "messaging" | "calendar" | "tasks" | "notes" | "system" | "core"
   * "core" tools are always advertised. Untagged tools fall back to
   * the prefix-based heuristic in `inferDomain`.
   */
  readonly domain?: string;
  /**
   * Optional free-text argument names that must be GROUNDED in the user's
   * utterance. The runtime drops any such arg the model fabricated (an 8B
   * invents a calendar `location`/`notes` the user never said). Muse-side
   * metadata; never sent to the provider (only `inputSchema` is).
   */
  readonly groundedArgs?: readonly string[];
}

export interface MuseToolContext {
  readonly runId: string;
  readonly userId?: string;
}

export type ToolExecutionValue = string | JsonValue;

export interface MuseTool {
  readonly definition: MuseToolDefinition;
  execute(args: JsonObject, context: MuseToolContext): Promise<ToolExecutionValue> | ToolExecutionValue;
}


export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly context: MuseToolContext;
}

export interface ToolExecutionResult {
  readonly id: string;
  readonly name: string;
  readonly status: ToolExecutionStatus;
  readonly output: string;
  readonly sanitized?: SanitizedToolOutput;
  readonly error?: string;
}

export interface ToolIdempotencyStore {
  get(key: string): ToolExecutionResult | undefined;
  set(key: string, result: ToolExecutionResult): unknown;
}

export interface ToolDescriptionIssue {
  readonly code: "missing_description" | "missing_input_schema" | "ambiguous_risk" | "duplicate_name" | "unknown_dependency" | "undescribed_parameter";
  readonly message: string;
  readonly toolName: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, MuseTool>();

  constructor(tools: Iterable<MuseTool> = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: MuseTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new ToolRegistryError(`Duplicate tool registered: ${tool.definition.name}`);
    }

    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): MuseTool | undefined {
    return this.tools.get(name);
  }

  list(): readonly MuseTool[] {
    return [...this.tools.values()];
  }

  toModelTools(): readonly ModelTool[] {
    return this.list().map((tool) => toModelTool(tool));
  }

  selectForContext(context: ToolExposureContext = {}, policy: ToolExposurePolicy = createDefaultToolExposurePolicy()): ToolExposureSelection {
    return policy.select(this.list(), context);
  }

  planForContext(context: ToolExposureContext = {}, policy: ToolExposurePolicy = createDefaultToolExposurePolicy()): WorkspaceToolRoutingPlan {
    return createWorkspaceToolRoutingPlan(this.list(), context, policy);
  }
}

export { coerceToolArguments, coerceEnumArguments, validateRequiredToolArguments, type ToolArgumentValidation } from "./tools-argument-validation.js";

// ToolExecutor lives in `./executor.ts` (lifted out so the
// tool-execution loop stays in one cohesive module). Re-exported
// at the bottom of this file so the `@muse/tools` barrel keeps
// working without import-site edits.

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

export {
  DefaultToolExposurePolicy,
  createDefaultToolExposurePolicy,
  createWorkspaceToolRoutingPlan,
  filterToolsForContext,
  isWorkspaceMutationPrompt,
  keywordMatchesPromptTokens,
  tokenMatchesKeywordWord,
  type DefaultToolExposurePolicyOptions,
  type ToolExposureBlock,
  type ToolExposureContext,
  type ToolExposurePolicy,
  type ToolExposureScope,
  type ToolExposureSelection,
  type WorkspaceToolRoutingPlan
} from "./tool-exposure-policy.js";

export {
  planToolExecutionOrder,
  shortenToolDescription,
  toModelTool,
  validateToolDefinitions
} from "./tool-definition-helpers.js";

export { createMuseTools, hasNestedUnboundedQuantifier, type MuseToolFactoryOptions } from "./muse-tools.js";

export { createRunToolPlanTool } from "./muse-tools-plan.js";

/**
 * Rust runner integration. Implementation lives in `./runner.ts`
 * (lifted out so the runner-protocol code stays cohesive). Re-exported
 * here so the `@muse/tools` barrel and existing tests keep working
 * without import-site edits.
 */
export {
  attachReadStreamErrorAbsorber,
  createRustRunnerTool,
  invokeRustRunner,
  MAX_RUNNER_OUTPUT_BYTES,
  MAX_RUNNER_TIMEOUT_MS,
  parseRunnerCommandRequest,
  runnerWatchdogMs,
  writeRunnerStdin,
  type RunnerCommandRequest,
  type RunnerCommandResponse,
  type RustRunnerToolOptions
} from "./runner.js";

export { classifyDangerousCommand, normalizeCommandForGuard, type DangerousCommandVerdict } from "./dangerous-command.js";
export { classifyCommandTopology, type CommandTopologyVerdict } from "./command-topology.js";
export { classifyRunnerFailure, type RunnerFailureKind, type RunnerFailureSignal } from "./runner-failure.js";

export { ToolExecutor, nearestToolName, toolErrorHint } from "./executor.js";

export {
  createSkillListTool,
  createSkillReadTool,
  createSkillRunTool,
  type SkillCatalogToolEntry,
  type SkillRegistryView,
  type SkillRunOptions
} from "./muse-tools-skills.js";

export {
  normalizeToolName,
  extractCandidateNames,
  tallyPeakedness,
  recommendRename,
  formatCalibrationReport,
  type PeakednessRow,
  type RenameCandidate,
  type RenameDecisionInput,
  type RenameDecision,
  type CalibrationResult
} from "./tool-name-calibration.js";

export {
  parseNaturalLanguageToolSelection,
  type NlToolSelection
} from "./nl-tool-selection.js";
