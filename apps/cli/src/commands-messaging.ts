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

import { confirm, isCancel } from "@clack/prompts";
import { buildMessagingRegistry, resolveActionLogFile } from "@muse/autoconfigure";
import type {
  InboundMessage,
  MessagingProviderInfo,
  MessagingProviderRegistry,
  OutboundReceipt
} from "@muse/messaging";
import { sendMessageWithApproval, type MessageApprovalGate } from "@muse/domain-tools";
import { stripUntrustedTerminalChars } from "@muse/shared";
import type { Command } from "commander";

import { formatProvidersList } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

/**
 * Test seam + defense-in-depth for `muse messaging send`. Defaults route the
 * draft through a terminal confirm + the real action log; tests inject a gate
 * and a fake registry to prove deny ⇒ no send (per outbound-safety.md).
 */
export interface MessagingSendDeps {
  readonly approvalGate?: MessageApprovalGate;
  readonly actionLogFile?: string;
  readonly registry?: Pick<MessagingProviderRegistry, "send">;
}

/**
 * One human-readable inbox line. `text` / `sender` / `source` are
 * attacker-controlled (anyone who messages the bot) and printed
 * straight to the terminal, so they get the same ESC/C0/C1/DEL
 * strip + whitespace-collapse the agent-context inbox applies — a
 * message must not be able to hijack the terminal.
 */
export function formatInboxLine(entry: InboundMessage): string {
  const clean = (value: string): string =>
    stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim();
  const sender = entry.sender ? `@${clean(entry.sender)}` : `chat ${clean(entry.source)}`;
  const time = entry.receivedAtIso.slice(0, 16).replace("T", " ");
  return `  ${time}  ${sender}: ${clean(entry.text)}`;
}

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
  helpers: MessagingCommandHelpers,
  deps: MessagingSendDeps = {}
): void {
  const messaging = program.command("messaging").description("Outbound messengers (Telegram / Discord / Slack / LINE)");

  messaging
    .command("providers")
    .description("List configured messaging providers (--local skips the API)")
    .option("--local", "Build the registry from process.env directly instead of querying the API")
    .option("--json", "Print the raw response instead of the formatted list")
    .action(async (options: SharedOptions, command) => {
      let providers: readonly MessagingProviderInfo[];
      if (options.local) {
        const registry = buildMessagingRegistry(process.env as Record<string, string | undefined>);
        providers = registry.describe();
      } else {
        const payload = await helpers.apiRequest(io, command, "/api/messaging/providers") as {
          readonly providers?: readonly MessagingProviderInfo[];
        };
        providers = payload.providers ?? [];
      }
      if (options.json) {
        helpers.writeOutput(io, { providers });
        return;
      }
      io.stdout(formatProvidersList("Messaging providers", providers));
    });

  messaging
    .command("inbox")
    .description("Fetch recent inbound messages (Phase 2.a — Telegram + Discord; one-shot, no offset state)")
    .argument("<provider>", "Provider id: telegram | discord (Slack/LINE inbound coming later)")
    .option("--limit <n>", "Max messages (default 20, max 100)")
    .option("--source <id>", "Platform-native source (Discord channel id; Telegram ignores it)")
    .option("--local", "Build the registry from process.env directly instead of GETing the API")
    .option("--json", "Print the raw inbound array instead of the formatted list")
    .action(async (
      provider: string,
      options: { readonly limit?: string; readonly source?: string } & SharedOptions,
      command
    ) => {
      const limitNum = options.limit ? Number(options.limit) : undefined;
      let inbound: readonly InboundMessage[];
      if (options.local) {
        const registry = buildMessagingRegistry(process.env as Record<string, string | undefined>);
        const opts: { limit?: number; source?: string } = {};
        if (limitNum !== undefined && Number.isFinite(limitNum)) {
          opts.limit = limitNum;
        }
        if (options.source && options.source.length > 0) {
          opts.source = options.source;
        }
        inbound = await registry.fetchInbound(provider, Object.keys(opts).length > 0 ? opts : undefined);
      } else {
        const params = new URLSearchParams({ providerId: provider });
        if (limitNum !== undefined && Number.isFinite(limitNum)) {
          params.set("limit", String(limitNum));
        }
        if (options.source && options.source.length > 0) {
          params.set("source", options.source);
        }
        const response = await helpers.apiRequest(io, command, `/api/messaging/inbox?${params.toString()}`) as {
          readonly inbound?: readonly InboundMessage[];
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
      const lines = inbound.map(formatInboxLine);
      io.stdout(`Inbox (${provider}, ${inbound.length}):\n${lines.join("\n")}\n`);
    });

  messaging
    .command("send")
    .description("Send a message via a configured provider (--local skips the API)")
    .argument("<provider>", "Provider id: telegram | discord | slack | line")
    .argument("<destination>", "Platform-native chat / channel / user id")
    .argument("<text...>", "Message text (joined by spaces)")
    .option("--local", "Build the registry from process.env directly instead of POSTing to the API")
    .option("--user <id>", "User identity for the action log", "stark")
    .option("--json", "Print the raw receipt instead of a short confirmation")
    .action(async (
      provider: string,
      destination: string,
      textParts: readonly string[],
      options: SharedOptions & { readonly user?: string },
      command
    ) => {
      const text = textParts.join(" ").trim();
      if (text.length === 0) {
        throw new Error("text is required");
      }
      // --local sends to a THIRD PARTY straight from this process, so it must be
      // draft-first + fail-closed + action-logged like `muse email send` — never
      // an autonomous send (outbound-safety.md). The default gate shows the exact
      // draft and waits for an explicit terminal confirm. (The API path is gated
      // server-side via the runtime tool-approval gate.)
      if (options.local) {
        const registry = deps.registry ?? buildMessagingRegistry(process.env as Record<string, string | undefined>);
        const gate: MessageApprovalGate = deps.approvalGate ?? ((draft) => {
          // Fail-closed when the confirm prompt can't be delivered: a non-TTY
          // (piped / scripted / CI) has no one to confirm, so refuse rather than
          // hang waiting on stdin or send unconfirmed (outbound-safety.md rule 2).
          if (!process.stdin.isTTY) {
            return { approved: false, reason: "no interactive terminal to confirm the send (run it in a terminal)" };
          }
          io.stdout(`\nSend via ${draft.providerId} → ${draft.destination}:\n\n${draft.text}\n\n`);
          return confirm({ message: "Send this message?" }).then((answer) =>
            isCancel(answer) || answer !== true
              ? { approved: false, reason: "user did not confirm" }
              : { approved: true });
        });
        const outcome = await sendMessageWithApproval({
          actionLogFile: deps.actionLogFile ?? resolveActionLogFile(process.env as Record<string, string | undefined>),
          approvalGate: gate,
          destination,
          providerId: provider,
          registry,
          text,
          userId: options.user ?? "stark"
        });
        if (!outcome.sent) {
          io.stderr(`Not sent (${outcome.reason}): ${outcome.detail}\n`);
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          helpers.writeOutput(io, { destination: outcome.destination, messageId: outcome.messageId });
          return;
        }
        io.stdout(`Sent ${provider} → ${outcome.destination} (id ${outcome.messageId})\n`);
        return;
      }

      const receipt = await helpers.apiRequest(
        io,
        command,
        "/api/messaging/send",
        { destination, providerId: provider, text },
        "POST"
      ) as OutboundReceipt;
      if (options.json) {
        helpers.writeOutput(io, receipt);
        return;
      }
      io.stdout(`Sent ${provider} → ${destination} (id ${receipt.messageId})\n`);
    });
}
