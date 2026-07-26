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
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { buildMessagingRegistry, resolveActionLogFile } from "@muse/autoconfigure";
import {
  readOutboundEffect,
  readOutboundEffects,
  reconcileOutboundEffect,
  type OutboundEffectView,
  type InboundMessage,
  type MessagingProviderInfo,
  type MessagingProviderRegistry,
  type OutboundReceipt
} from "@muse/messaging";
import { sendMessageWithApproval, type MessageApprovalGate } from "@muse/domain-tools";
import { stripUntrustedTerminalChars } from "@muse/shared";
import type { Command } from "commander";

import { resolveCliLanguage } from "./cli-i18n.js";
import { formatProvidersList } from "./human-formatters.js";
import { readConfigStore } from "./program-config.js";
import type { ProgramIO } from "./program.js";

/**
 * Test seam + defense-in-depth for `muse messaging send`. Defaults route the
 * draft through a terminal confirm + the real action log; tests inject a gate
 * and a fake registry to prove deny ⇒ no send (per outbound-safety.md).
 */
export interface MessagingSendDeps {
  readonly approvalGate?: MessageApprovalGate;
  readonly actionLogFile?: string;
  readonly effectFile?: string;
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

const EFFECT_LIST_DEFAULT = 50;
const EFFECT_LIST_MAX = 100;

export function registerMessagingCommands(
  program: Command,
  io: ProgramIO,
  helpers: MessagingCommandHelpers,
  deps: MessagingSendDeps = {}
): void {
  const messaging = program.command("messaging").description("Outbound messengers (Telegram / Discord / Slack / LINE)");
  const effects = messaging
    .command("effects")
    .description("Inspect and manually reconcile durable outbound effects (local only)");

  effects
    .command("list")
    .description("List durable outbound effects without revealing message payloads")
    .option("--limit <n>", `Maximum effects to print (default ${EFFECT_LIST_DEFAULT.toString()}, max ${EFFECT_LIST_MAX.toString()})`)
    .action(async (options: { readonly limit?: string }) => {
      await runEffectCommand(io, async () => {
        const entries = await readOutboundEffects(resolveEffectFile(deps));
        const limit = parseEffectLimit(options.limit);
        io.stdout(`${JSON.stringify({
          effects: entries.slice(-limit).map(safeEffectView),
          total: entries.length
        })}\n`);
      });
    });

  effects
    .command("show")
    .description("Show one durable outbound effect without revealing its payload")
    .argument("<effectId>", "Durable outbound effect id")
    .action(async (effectId: string) => {
      await runEffectCommand(io, async () => {
        const effect = await readOutboundEffect(resolveEffectFile(deps), effectId);
        if (!effect) throw new Error("outbound effect not found");
        io.stdout(`${JSON.stringify(safeEffectView(effect))}\n`);
      });
    });

  effects
    .command("reconcile")
    .description("Preview or apply a manual terminal decision for an unknown outbound effect")
    .argument("<effectId>", "Durable outbound effect id")
    .requiredOption("--decision <decision>", "accepted | not-delivered")
    .requiredOption("--actor <actor>", "Operator recording this decision")
    .requiredOption("--reason <reason>", "Reason and supporting evidence for the decision")
    .option("--message-id <id>", "Exact provider message id (required only for accepted)")
    .option("--received-at <iso>", "Canonical provider receipt timestamp (required only for accepted)")
    .option("--apply", "Apply the previewed transition; without this flag no bytes change")
    .action(async (
      effectId: string,
      options: {
        readonly actor: string;
        readonly apply?: boolean;
        readonly decision: string;
        readonly messageId?: string;
        readonly reason: string;
        readonly receivedAt?: string;
      }
    ) => {
      await runEffectCommand(io, async () => {
        validateReconciliationText(effectId, "effectId", 512);
        validateReconciliationText(options.actor, "actor", 256);
        validateReconciliationText(options.reason, "reason", 1_000);
        if (options.decision !== "accepted" && options.decision !== "not-delivered") {
          throw new Error("decision must be accepted or not-delivered");
        }
        const effectFile = resolveEffectFile(deps);
        // This read is deliberately adjacent to apply. If another process wins
        // after it, the store's lock and unknown-only transition fail closed.
        const current = await readOutboundEffect(effectFile, effectId);
        if (!current) throw new Error("outbound effect not found");
        if (current.state !== "unknown") {
          throw new Error(`outbound effect is terminal in state ${safeText(current.state, 64)}`);
        }
        const recordedAt = new Date().toISOString();
        let receipt:
          | {
              readonly destination: string;
              readonly messageId: string;
              readonly providerId: string;
              readonly receivedAt: string;
            }
          | undefined;
        if (options.decision === "accepted") {
          if (options.messageId === undefined || options.receivedAt === undefined) {
            throw new Error("accepted requires --message-id and --received-at");
          }
          validateReconciliationText(options.messageId, "messageId", 512);
          assertCanonicalTimestamp(options.receivedAt, "receivedAt");
          if (Date.parse(options.receivedAt) < Date.parse(current.binding.createdAt)) {
            throw new Error("receivedAt must not precede the effect creation time");
          }
          if (Date.parse(options.receivedAt) > Date.parse(recordedAt)) {
            throw new Error("receivedAt must not be in the future");
          }
          receipt = {
            destination: current.binding.destination,
            messageId: options.messageId,
            providerId: current.binding.providerId,
            receivedAt: options.receivedAt
          };
        } else if (options.messageId !== undefined || options.receivedAt !== undefined) {
          throw new Error("not-delivered forbids --message-id and --received-at");
        }
        const transition = {
          actor: options.actor,
          decision: options.decision,
          effectId,
          reason: options.reason,
          recordedAt,
          ...(receipt ? { receipt } : {})
        } as const;
        io.stdout(`${JSON.stringify({
          status: options.apply ? "applying" : "preview",
          transition: safeReconciliationTransition(transition)
        })}\n`);
        if (!options.apply) return;
        const applied = await reconcileOutboundEffect(effectFile, transition);
        io.stdout(`${JSON.stringify({ effect: safeEffectView(applied), status: "applied" })}\n`);
      });
    });

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
      await resolveCliLanguage(process.env, () => readConfigStore(io));
      io.stdout(formatProvidersList("Messaging providers", providers));
    });

  messaging
    .command("pairing-code")
    .description("Print a provider's one-time pairing code — send it to the bot from your own chat to link it (security finding #9: replaces silent first-message adoption)")
    .argument("<provider>", "Provider id: telegram | discord | slack | line | matrix")
    .option("--json", "Print the raw provider entry instead of formatted text")
    .action(async (provider: string, options: { readonly json?: boolean }, command) => {
      const payload = await helpers.apiRequest(io, command, "/api/messaging/setup") as {
        readonly providers?: readonly {
          readonly id: string;
          readonly configured: boolean;
          readonly pairedOwner?: string;
          readonly pairingCode?: string;
        }[];
      };
      const entry = payload.providers?.find((candidate) => candidate.id === provider);
      if (!entry) {
        io.stderr(`unknown messaging provider "${provider}"\n`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        helpers.writeOutput(io, entry);
        return;
      }
      if (!entry.configured) {
        io.stdout(`${provider} is not connected yet — connect it first (web console Integrations, or POST /api/messaging/setup/${provider}).\n`);
        return;
      }
      if (entry.pairedOwner) {
        io.stdout(`${provider} is already paired — no code needed. Use "reset pairing" in the web console to re-pair a different chat.\n`);
        return;
      }
      if (!entry.pairingCode) {
        io.stdout(`No active pairing code for ${provider} yet — try again in a moment.\n`);
        return;
      }
      io.stdout(`Pairing code for ${provider}: ${entry.pairingCode}\nSend this code as a message to the bot from the chat you want to link as its owner.\n`);
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
    .option("--effect-id <id>", "Stable recovery id; reuse only for the same intended send")
    .option("--json", "Print the raw receipt instead of a short confirmation")
    .action(async (
      provider: string,
      destination: string,
      textParts: readonly string[],
      options: SharedOptions & { readonly effectId?: string; readonly user?: string },
      command
    ) => {
      const text = textParts.join(" ").trim();
      if (text.length === 0) {
        throw new Error("text is required");
      }
      const effectId = options.effectId?.trim() || randomUUID();
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
          ...(deps.effectFile ? { effectFile: deps.effectFile } : {}),
          effectId,
          providerId: provider,
          registry,
          text,
          userId: options.user ?? "stark"
        });
        if (!outcome.sent) {
          io.stderr(`Not sent (${outcome.reason}): ${outcome.detail} (effect ${outcome.effectId})\n`);
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          helpers.writeOutput(io, {
            destination: outcome.destination,
            effectId: outcome.effectId,
            messageId: outcome.messageId
          });
          return;
        }
        io.stdout(
          `Sent ${provider} → ${outcome.destination} ` +
          `(id ${outcome.messageId}, effect ${outcome.effectId})\n`
        );
        return;
      }

      const receipt = await helpers.apiRequest(
        io,
        command,
        "/api/messaging/send",
        { destination, effectId, providerId: provider, text },
        "POST"
      ) as OutboundReceipt & { readonly effectId?: string };
      const confirmedEffectId = receipt.effectId ?? effectId;
      if (options.json) {
        helpers.writeOutput(io, { ...receipt, effectId: confirmedEffectId });
        return;
      }
      io.stdout(
        `Sent ${provider} → ${destination} ` +
        `(id ${receipt.messageId}, effect ${confirmedEffectId})\n`
      );
    });
}

function resolveEffectFile(deps: MessagingSendDeps): string {
  if (deps.effectFile) return deps.effectFile;
  const actionLogFile = deps.actionLogFile
    ?? resolveActionLogFile(process.env as Record<string, string | undefined>);
  return join(dirname(actionLogFile), "outbound-effects.json");
}

function parseEffectLimit(raw: string | undefined): number {
  if (raw === undefined) return EFFECT_LIST_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > EFFECT_LIST_MAX) {
    throw new Error(`limit must be an integer from 1 to ${EFFECT_LIST_MAX.toString()}`);
  }
  return parsed;
}

async function runEffectCommand(io: ProgramIO, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "outbound effect operation failed";
    io.stderr(`Outbound effect operation failed: ${safeText(message, 1_000)}\n`);
    process.exitCode = 1;
  }
}

function validateReconciliationText(value: string, field: string, maxBytes: number): void {
  if (
    value.trim().length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maxBytes
    || /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${field} must be a non-empty exact value of at most ${maxBytes.toString()} UTF-8 bytes with no control characters`);
  }
}

function assertCanonicalTimestamp(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
}

function safeText(value: string, maxLength: number): string {
  return stripUntrustedTerminalChars(value).slice(0, maxLength);
}

function safeEffectView(effect: OutboundEffectView): Record<string, unknown> {
  return {
    binding: {
      createdAt: safeText(effect.binding.createdAt, 64),
      destination: safeText(effect.binding.destination, 512),
      effectId: safeText(effect.binding.effectId, 512),
      payloadHash: safeText(effect.binding.payloadHash, 64),
      providerId: safeText(effect.binding.providerId, 128)
    },
    state: safeText(effect.state, 64),
    ...(effect.unknownDetail !== undefined
      ? { unknownDetail: safeText(effect.unknownDetail, 1_000) }
      : {}),
    ...(effect.receipt
      ? {
          receipt: {
            destination: safeText(effect.receipt.destination, 512),
            messageId: safeText(effect.receipt.messageId, 512),
            providerId: safeText(effect.receipt.providerId, 128),
            receivedAt: safeText(effect.receipt.receivedAt, 64),
            ...(effect.receipt.providerReceiptDigest
              ? { providerReceiptDigest: safeText(effect.receipt.providerReceiptDigest, 64) }
              : {})
          }
        }
      : {}),
  };
}

function safeReconciliationTransition(transition: {
  readonly actor: string;
  readonly decision: "accepted" | "not-delivered";
  readonly effectId: string;
  readonly reason: string;
  readonly recordedAt: string;
  readonly receipt?: {
    readonly destination: string;
    readonly messageId: string;
    readonly providerId: string;
    readonly receivedAt: string;
  };
}): Record<string, unknown> {
  return {
    actor: safeText(transition.actor, 256),
    decision: transition.decision,
    effectId: safeText(transition.effectId, 512),
    reason: safeText(transition.reason, 1_000),
    recordedAt: safeText(transition.recordedAt, 64),
    ...(transition.receipt
      ? {
          receipt: {
            destination: safeText(transition.receipt.destination, 512),
            messageId: safeText(transition.receipt.messageId, 512),
            providerId: safeText(transition.receipt.providerId, 128),
            receivedAt: safeText(transition.receipt.receivedAt, 64)
          }
        }
      : {})
  };
}
