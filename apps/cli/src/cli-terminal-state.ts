import { redactSecretsInText } from "@muse/shared";

export const CLI_EXIT_CODES = Object.freeze({
  success: 0,
  "internal-failure": 1,
  "user-error": 2,
  "policy-block": 3,
  unverified: 4
} as const);

export type CliTerminalState = keyof typeof CLI_EXIT_CODES;

const POLICY_ERROR_CODES = new Set([
  "APPROVAL_DENIED",
  "APPROVAL_REQUIRED",
  "EGRESS_BLOCKED",
  "GUARD_BLOCKED",
  "INJECTION_DETECTED",
  "PERMISSION_DENIED",
  "POLICY_BLOCKED",
  "VETOED"
]);
const UNAVAILABLE_ERROR_CODES = new Set([
  "AGENT_RUNTIME_UNAVAILABLE",
  "UPSTREAM_UNAVAILABLE"
]);
const GLOBAL_OPTIONS_WITH_VALUE = new Set(["--api-url", "--token"]);

export class CliTerminalStateError extends Error {
  readonly terminalState: Exclude<CliTerminalState, "success">;
  readonly errorCode?: string;

  constructor(
    terminalState: Exclude<CliTerminalState, "success">,
    message: string,
    errorCode?: string
  ) {
    super(message);
    this.name = "CliTerminalStateError";
    this.terminalState = terminalState;
    this.errorCode = errorCode;
  }
}

export function cliExitCode(state: CliTerminalState): number {
  return CLI_EXIT_CODES[state];
}

export function terminalStateFromExitCode(code: number | string | null | undefined): CliTerminalState {
  const numeric = typeof code === "string" ? Number(code) : code;
  for (const [state, exitCode] of Object.entries(CLI_EXIT_CODES) as Array<[CliTerminalState, number]>) {
    if (numeric === exitCode) return state;
  }
  return numeric === 0 || numeric === null || numeric === undefined ? "success" : "internal-failure";
}

export function classifyApiTerminalState(
  status: number,
  errorCode?: string
): Exclude<CliTerminalState, "success"> {
  const normalizedErrorCode = errorCode?.trim().toUpperCase();
  if (normalizedErrorCode !== undefined && POLICY_ERROR_CODES.has(normalizedErrorCode)) {
    return "policy-block";
  }
  if (normalizedErrorCode !== undefined && UNAVAILABLE_ERROR_CODES.has(normalizedErrorCode)) {
    return "unverified";
  }
  if (status === 408 || status === 425 || status === 504) return "unverified";
  if (status >= 400 && status < 500) return "user-error";
  return "internal-failure";
}

export function classifyCliTerminalState(error: unknown): CliTerminalState {
  if (error instanceof CliTerminalStateError) return error.terminalState;
  if (isCommanderExit(error)) {
    return error.exitCode === 0 ? "success" : "user-error";
  }
  if (error instanceof SyntaxError) return "user-error";
  if (
    error instanceof TypeError
    || error instanceof RangeError
    || error instanceof ReferenceError
    || error instanceof EvalError
    || error instanceof URIError
  ) {
    return "internal-failure";
  }
  return error instanceof Error && error.message.trim().length > 0
    ? "user-error"
    : "internal-failure";
}

export function setCliTerminalState(
  state: CliTerminalState,
  target: { exitCode?: number | string | null } = process
): void {
  target.exitCode = cliExitCode(state);
}

export function jsonTerminalFailure(
  error: unknown,
  state: Exclude<CliTerminalState, "success">,
  options: { readonly command?: string; readonly fallbackMessage?: string } = {}
): string {
  const message = redactSecretsInText(errorMessage(error, options.fallbackMessage));
  const code = error instanceof CliTerminalStateError
    ? error.errorCode
    : commanderCode(error);
  return `${JSON.stringify({
    schemaVersion: 1,
    ok: false,
    terminalState: state,
    exitCode: cliExitCode(state),
    ...(options.command ? { command: options.command } : {}),
    error: {
      ...(code ? { code } : {}),
      message
    }
  })}\n`;
}

export function jsonModeRequested(argv: readonly string[]): boolean {
  return argv.some((argument) => argument === "--json");
}

export function commandNameFromArgv(argv: readonly string[]): string {
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (GLOBAL_OPTIONS_WITH_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("--api-url=") || argument.startsWith("--token=") || argument.startsWith("-")) {
      continue;
    }
    return argument;
  }
  return "";
}

function isCommanderExit(error: unknown): error is { readonly code: string; readonly exitCode: number } {
  return typeof error === "object"
    && error !== null
    && typeof (error as { code?: unknown }).code === "string"
    && (error as { code: string }).code.startsWith("commander.")
    && typeof (error as { exitCode?: unknown }).exitCode === "number";
}

function commanderCode(error: unknown): string | undefined {
  return isCommanderExit(error) ? error.code : undefined;
}

function errorMessage(error: unknown, fallback = "CLI operation failed"): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  return fallback.trim().length > 0 ? fallback.trim() : "CLI operation failed";
}
