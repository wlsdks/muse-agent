/**
 * Shared error types for `@muse/agent-core`.
 *
 * Kept in a tiny dedicated module so deep submodules (checkpoint codec,
 * plan-execute, response filters) can throw consistent error types without
 * pulling in the full AgentRuntime surface.
 */

export class GuardBlockedError extends Error {
  readonly guardId: string;
  readonly code?: string;

  constructor(guardId: string, reason: string, code?: string) {
    super(reason);
    this.name = "GuardBlockedError";
    this.guardId = guardId;
    if (code !== undefined) {
      this.code = code;
    }
  }
}

export class OutputGuardBlockedError extends Error {
  readonly stageId: string;
  readonly code?: string;

  constructor(stageId: string, reason: string, code?: string) {
    super(reason);
    this.name = "OutputGuardBlockedError";
    this.stageId = stageId;
    if (code !== undefined) {
      this.code = code;
    }
  }
}

export class ModelRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRoutingError";
  }
}
