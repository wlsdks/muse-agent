import { errorMessage } from "@muse/shared";
/**
 * `muse setup messaging` — interactive wizard that walks the user
 * through enabling Telegram / Discord / Slack / LINE bots and
 * persists the tokens to `~/.muse/messaging.json` (chmod 600 via
 * `FileMessagingCredentialStore`). Mirrors `setup-calendar.ts`
 * shape so the two onboarding flows feel identical.
 *
 * Skipped on purpose:
 *   - KakaoTalk (Kakao restricts general bots to verified business
 *     channels; unofficial libs violate ToS).
 *
 * Each prompt shows the platform-specific docs URL so the user can
 * grab the token without leaving the wizard:
 *   - Telegram: https://core.telegram.org/bots/tutorial
 *   - Discord:  https://discord.com/developers/applications
 *   - Slack:    https://api.slack.com/apps  (Bot User OAuth, xoxb-)
 *   - LINE:     https://developers.line.biz/console
 */

import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import { confirm, isCancel, multiselect, password } from "@clack/prompts";
import { FileMessagingCredentialStore } from "@muse/messaging";
import { isLocalOnlyEnabled } from "@muse/model";

interface SetupMessagingIO {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
  readonly home?: string;
  /** Optional test seam; production commands inherit process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface ProviderSpec {
  readonly id: "telegram" | "discord" | "slack" | "line";
  readonly label: string;
  readonly tokenLabel: string;
  readonly docs: string;
  readonly placeholderHint: string;
}

const PROVIDER_SPECS: readonly ProviderSpec[] = [
  {
    docs: "https://core.telegram.org/bots/tutorial",
    id: "telegram",
    label: "Telegram (Bot API)",
    placeholderHint: "123456:ABC-DEF...",
    tokenLabel: "Bot token from @BotFather"
  },
  {
    docs: "https://discord.com/developers/applications",
    id: "discord",
    label: "Discord (Bot)",
    placeholderHint: "MTAxNzY...",
    tokenLabel: "Bot token (no `Bot ` prefix)"
  },
  {
    docs: "https://api.slack.com/apps",
    id: "slack",
    label: "Slack (chat.postMessage)",
    placeholderHint: "xoxb-...",
    tokenLabel: "Bot User OAuth token (xoxb-...)"
  },
  {
    docs: "https://developers.line.biz/console",
    id: "line",
    label: "LINE (Messaging API push)",
    placeholderHint: "long base64-style string",
    tokenLabel: "Channel access token (long-lived)"
  }
];

export async function runMessagingSetup(io: SetupMessagingIO): Promise<void> {
  if (isLocalOnlyEnabled(io.env ?? process.env)) {
    io.stdout(
      "Remote bot setup is disabled while MUSE_LOCAL_ONLY=true. "
      + "Local log/native notifications remain available. "
      + "Set MUSE_LOCAL_ONLY=false to configure Telegram, Discord, Slack, LINE, or Matrix.\n"
    );
    return;
  }
  const home = io.home ?? homedir();
  const credentialsFile = pathJoin(home, ".muse", "messaging.json");
  const store = new FileMessagingCredentialStore(credentialsFile);

  io.stdout(`Messaging setup — tokens will be saved to ${credentialsFile} (chmod 600).\n`);
  io.stdout("Outbound only this iter (send). Inbound polling/Socket Mode/webhook lands in a follow-up.\n\n");

  const selection = await multiselect({
    message: "Which messaging providers do you want to enable?",
    options: PROVIDER_SPECS.map((spec) => ({ label: spec.label, value: spec.id })),
    required: true
  });

  if (isCancel(selection)) {
    io.stdout("Setup cancelled.\n");
    return;
  }

  const requested = selection as readonly ProviderSpec["id"][];

  for (const id of requested) {
    const spec = PROVIDER_SPECS.find((entry) => entry.id === id);
    if (!spec) {
      continue;
    }
    io.stdout(`\n${spec.label}\n  Docs: ${spec.docs}\n`);

    const existing = await store.load(spec.id);
    if (existing && typeof existing.token === "string" && existing.token.length > 0) {
      const replace = await confirm({
        initialValue: false,
        message: `${spec.id} already has a token saved (${maskToken(String(existing.token))}). Replace it?`
      });
      if (isCancel(replace) || replace !== true) {
        io.stdout(`- ${spec.id} — kept existing token\n`);
        continue;
      }
    }

    const token = await password({
      mask: "*",
      message: `${spec.tokenLabel} (${spec.placeholderHint}):`,
      validate: (value) => {
        if (!value || value.trim().length === 0) {
          return "Token must not be empty";
        }
        return undefined;
      }
    });

    if (isCancel(token)) {
      io.stdout(`- ${spec.id} — skipped\n`);
      continue;
    }

    try {
      await store.save(spec.id, { token: String(token).trim() });
      io.stdout(`✓ ${spec.id} — token saved\n`);
    } catch (cause) {
      io.stderr(`failed to save ${spec.id}: ${errorMessage(cause)}\n`);
    }
  }

  io.stdout("\nDone. Restart the API server (or re-run any --local CLI) for changes to take effect.\n");
}

function maskToken(token: string): string {
  if (token.length <= 8) {
    return "****";
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

