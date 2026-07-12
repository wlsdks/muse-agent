import { createToolExposureAuthority, type ToolExposureAuthority } from "@muse/policy";

export const TRUSTED_CLI_PERSONAL_READ_TOOL_ALLOWLIST = [
  "muse.notes.list", "muse.notes.read", "muse.notes.search",
  "muse.tasks.list", "muse.tasks.search",
  "muse.calendar.providers", "muse.calendar.list",
  "muse.calendar.availability", "muse.calendar.conflicts",
  "muse.reminders.list", "muse.reminders.search"
] as const;

export const TRUSTED_CLI_NOTES_READ_TOOL_ALLOWLIST = [
  "muse.notes.list", "muse.notes.read", "muse.notes.search"
] as const;

export const TRUSTED_CLI_PERSONAL_READ_MAX_TOOLS = 7 as const;

export function createTrustedAskToolExposureAuthority(options: { readonly notesOnly?: boolean } = {}): ToolExposureAuthority {
  return createToolExposureAuthority({
    allowedToolNames: options.notesOnly
      ? TRUSTED_CLI_NOTES_READ_TOOL_ALLOWLIST
      : TRUSTED_CLI_PERSONAL_READ_TOOL_ALLOWLIST
  });
}

export interface TrustedAskToolRun {
  readonly maxTools: typeof TRUSTED_CLI_PERSONAL_READ_MAX_TOOLS;
  readonly toolExposureAuthority: ToolExposureAuthority;
}

export function createTrustedAskToolRun(options: { readonly notesOnly?: boolean; readonly withTools?: boolean }): TrustedAskToolRun | undefined {
  if (options.withTools !== true) {
    return undefined;
  }
  return {
    maxTools: TRUSTED_CLI_PERSONAL_READ_MAX_TOOLS,
    toolExposureAuthority: createTrustedAskToolExposureAuthority({ notesOnly: options.notesOnly })
  };
}
