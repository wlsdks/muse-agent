/**
 * Windows autostart wiring for the resident `muse daemon` — the schtasks
 * counterpart of the macOS LaunchAgent plist. Pure argv builders: the argv
 * ARRAY goes to execFile (no shell), so paths are inert arguments; quoting
 * below is only what schtasks itself needs inside its /TR program line.
 */

export const SCHTASKS_TASK_NAME = "MuseDaemon";

function quoteForTaskRun(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

export function buildSchtasksCreateArgs(opts: {
  readonly taskName: string;
  readonly programArguments: readonly string[];
}): readonly string[] {
  const taskRun = opts.programArguments.map(quoteForTaskRun).join(" ");
  return ["/Create", "/F", "/SC", "ONLOGON", "/TN", opts.taskName, "/TR", taskRun];
}

export function buildSchtasksDeleteArgs(taskName: string): readonly string[] {
  return ["/Delete", "/F", "/TN", taskName];
}

export function buildSchtasksQueryArgs(taskName: string): readonly string[] {
  return ["/Query", "/TN", taskName];
}
