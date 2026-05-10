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
    .command("inbox")
    .description("Fetch recent inbound messages (Phase 2.a — Telegram only; one-shot, no offset state)")
    .argument("<provider>", "Provider id: telegram (Discord/Slack/LINE inbound coming later)")
    .option("--limit <n>", "Max messages (default 20, max 100)")
    .option("--local", "Build the registry from process.env directly instead of GETing the API (not yet wired)")
    .option("--json", "Print the raw inbound array instead of the formatted list")
    .action(async (
      provider: string,
      options: { readonly limit?: string } & SharedOptions,
      command
    ) => {
      const limitNum = options.limit ? Number(options.limit) : undefined;
      let inbound: ReadonlyArray<Record<string, unknown>>;
      if (options.local) {
        const registry = buildMessagingRegistry(process.env as Record<string, string | undefined>);
        const opts = limitNum !== undefined && Number.isFinite(limitNum) ? { limit: limitNum } : undefined;
        inbound = (await registry.fetchInbound(provider, opts)) as unknown as ReadonlyArray<Record<string, unknown>>;
      } else {
        const params = new URLSearchParams({ providerId: provider });
        if (limitNum !== undefined && Number.isFinite(limitNum)) {
          params.set("limit", String(limitNum));
        }
        const response = (await helpers.apiRequest(io, command, `/api/messaging/inbox?${params.toString()}`)) as {
          inbound: ReadonlyArray<Record<string, unknown>>;
        };
        inbound = response.inbound ?? [];
      }
      if (options.json) {
        helpers.writeOutput(io, { inbound, providerId: provider, total: inbound.length });
        return;
      }
      if (inbound.length === 0) {
        io.stdout(`Inbox (${provider}): (empty)\n`);
        return;
      }
      const lines = inbound.map((entry) => {
        const sender = entry.sender ? `@${String(entry.sender)}` : `chat ${String(entry.source ?? "?")}`;
        const time = String(entry.receivedAtIso ?? "").slice(0, 16).replace("T", " ");
        return `  ${time}  ${sender}: ${String(entry.text ?? "")}`;
      });
      io.stdout(`Inbox (${provider}, ${inbound.length}):\n${lines.join("\n")}\n`);
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
