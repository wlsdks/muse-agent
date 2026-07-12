import type { AskOptions } from "./ask-command-options.js";

type TrustedAskPreflightOptions = Pick<AskOptions, "actuators" | "apply" | "git" | "shell" | "url">;

type TrustedAskPreflightIO = Pick<{ readonly stderr: (message: string) => void }, "stderr">;

export function trustedAskB1RejectionMessages(options: TrustedAskPreflightOptions): readonly string[] {
  return [
    ...(options.actuators === true
      ? ["muse ask: --actuators is unavailable in Muse's non-coding personal-read mode."]
      : []),
    ...(options.apply === true
      ? ["muse ask: --apply is unavailable; Muse creates reviewable drafts only."]
      : []),
    ...(typeof options.url === "string"
      ? ["muse ask: --url is unavailable; provide the material locally to analyze it."]
      : []),
    ...(options.shell === true
      ? ["muse ask: --shell is unavailable; Muse does not inspect shell history."]
      : []),
    ...(options.git === true
      ? ["muse ask: --git is unavailable; Muse does not inspect repositories or git history."]
      : [])
  ];
}

export function assertTrustedAskB1Preflight(options: TrustedAskPreflightOptions, io: TrustedAskPreflightIO): boolean {
  const rejectionMessages = trustedAskB1RejectionMessages(options);
  if (rejectionMessages.length === 0) {
    return true;
  }

  for (const message of rejectionMessages) {
    io.stderr(`${message}\n`);
  }
  process.exitCode = 2;
  return false;
}
