/**
 * `muse messaging` command group — outbound messenger surface.
 *
 *   - `muse messaging providers` — list configured providers
 *   - `muse messaging send <provider> <destination> <text...>`
 *
 * Both subcommands honour `--local` to skip the API and route
 * through `buildMessagingRegistry(process.env)` directly. Phase 1
 * is send-only across Telegram / Discord / Slack / LINE; Phase 2
 * (inbound polling / Socket Mode / webhook) is tracked in
 * `docs/design/messaging.md`.
 */

import { buildMessagingRegistry } from "@muse/autoconfigure";
import type { Command } from "commander";

import { formatProvidersList } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

export interface MessagingCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

interface SharedOptions {
  readonly local?: boolean;
  readonly json?: boolean;
}

export function registerMessagingCommands(
  program: Command,
  io: ProgramIO,
  helpers: MessagingCommandHelpers
): void {
  const messaging = program.command("messaging").description("Outbound messengers (Telegram / Discord / Slack / LINE)");

  messaging
    .command("providers")
    .description("List configured messaging providers (--local skips the API)")
    .option("--local", "Build the registry from process.env directly instead of querying the API")
    .option("--json", "Print the raw response instead of the formatted list")
    .action(async (options: SharedOptions, command) => {
      let payload: { providers?: ReadonlyArray<Record<string, unknown>> };
      if (options.local) {
        const registry = buildMessagingRegistry(process.env as Record<string, string | undefined>);
        payload = { providers: registry.describe() as unknown as ReadonlyArray<Record<string, unknown>> };
      } else {
        payload = (await helpers.apiRequest(io, command, "/api/messaging/providers")) as typeof payload;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      const providers = (payload.providers ?? []) as Parameters<typeof formatProvidersList>[1];
      io.stdout(formatProvidersList("Messaging providers", providers));
    });

  messaging
    .command("send")
    .description("Send a message via a configured provider (--local skips the API)")
    .argument("<provider>", "Provider id: telegram | discord | slack | line")
    .argument("<destination>", "Platform-native chat / channel / user id")
    .argument("<text...>", "Message text (joined by spaces)")
    .option("--local", "Build the registry from process.env directly instead of POSTing to the API")
    .option("--json", "Print the raw receipt instead of a short confirmation")
    .action(async (
      provider: string,
      destination: string,
      textParts: readonly string[],
      options: SharedOptions,
      command
    ) => {
      const text = textParts.join(" ").trim();
      if (text.length === 0) {
        throw new Error("text is required");
      }
      let receipt: Record<string, unknown>;
      if (options.local) {
        const registry = buildMessagingRegistry(process.env as Record<string, string | undefined>);
        receipt = await registry.send(provider, { destination, text }) as unknown as Record<string, unknown>;
      } else {
        receipt = (await helpers.apiRequest(
          io,
          command,
          "/api/messaging/send",
          { destination, providerId: provider, text },
          "POST"
        )) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, receipt);
        return;
      }
      io.stdout(`Sent ${provider} → ${destination} (id ${String(receipt.messageId ?? "")})\n`);
    });
}
