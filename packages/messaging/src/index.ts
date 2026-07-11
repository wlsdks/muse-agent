export {
  MessagingProviderError,
  MessagingValidationError,
  isRetryableMessagingStatus,
  type MessagingErrorCode
} from "./errors.js";

export { MessagingProviderRegistry } from "./registry.js";

export {
  inboundKey,
  respondToInbound,
  type InboundAgentRunner,
  type RespondToInboundOptions,
  type RespondToInboundResult
} from "./inbound-responder.js";

export { appendReplyCursor, readReplyCursor } from "./inbox-reply-cursor.js";

export {
  appendThreadTurns,
  readThread,
  type ThreadTurn
} from "./inbound-thread-store.js";

export {
  createThreadedInboundRunner,
  type ThreadedAgentRun
} from "./inbound-threaded-runner.js";

export {
  createChannelApprovalGate,
  type ChannelApprovalGate,
  type ChannelApprovalGateDecision,
  type ChannelApprovalGateInput,
  type ChannelApprovalRefusal
} from "./channel-approval-gate.js";

export {
  clearPendingApproval,
  filterUnexpired,
  listPendingApprovals,
  readPendingApprovals,
  recordPendingApproval,
  type PendingApproval
} from "./pending-approval-store.js";

export { isApprovalReply } from "./is-approval-reply.js";

export {
  FileMessagingCredentialStore,
  type MessagingCredentialStore,
  type MessagingCredentials
} from "./credential-store.js";

export {
  verifyMessagingToken,
  type TokenVerification,
  type VerifyTokenOptions
} from "./token-verify.js";

export type {
  InboundFetchOptions,
  InboundMessage,
  MessagingProvider,
  MessagingProviderId,
  MessagingProviderInfo,
  OutboundMessage,
  OutboundReceipt
} from "./types.js";

export { TelegramProvider, clampForTelegram, escapeForTelegramParseMode, type TelegramProviderOptions } from "./telegram-provider.js";
export { DiscordProvider, type DiscordProviderOptions } from "./discord-provider.js";
export { SlackProvider, escapeSlackText, type SlackProviderOptions } from "./slack-provider.js";
export { LineProvider, type LineProviderOptions } from "./line-provider.js";
export { LogMessagingProvider, type LogMessagingProviderOptions } from "./log-provider.js";
export {
  MacosNotificationProvider,
  type MacosNotificationProviderOptions,
  type OsascriptRunner,
  type OsascriptRunResult
} from "./macos-notification-provider.js";
export {
  LinuxLibnotifyProvider,
  buildNotifySendArgv,
  type LibnotifyUrgency,
  type LinuxLibnotifyProviderOptions,
  type NotifySendRunner,
  type NotifySendRunResult
} from "./linux-libnotify-provider.js";

export { validateOutboundMessage } from "./validate.js";

export {
  appendInbound,
  MAX_READ_LIMIT,
  readInbox,
  type AppendInboundOptions
} from "./inbox-store.js";

export {
  readTelegramOffset,
  writeTelegramOffset
} from "./telegram-offset-store.js";

export {
  readDiscordAfter,
  writeDiscordAfter
} from "./discord-after-store.js";

export {
  readSlackAfter,
  writeSlackAfter
} from "./slack-after-store.js";

export {
  advanceInboxInjectionCursor,
  readInboxInjectionCursor,
  writeInboxInjectionCursor,
  type InboxInjectionCursor,
  type SourceCursor
} from "./inbox-injection-cursor.js";

export {
  FileBackedInboxContextProvider,
  filterFresh,
  type FileBackedInboxContextProviderOptions,
  type InboxSourceConfig,
  type InboxSnapshot as MessagingInboxSnapshot,
  type InboundSummary
} from "./inbox-surface.js";
