export {
  MessagingProviderError,
  MessagingValidationError,
  type MessagingErrorCode
} from "./errors.js";

export { MessagingProviderRegistry } from "./registry.js";

export {
  FileMessagingCredentialStore,
  type MessagingCredentialStore,
  type MessagingCredentials
} from "./credential-store.js";

export type {
  InboundFetchOptions,
  InboundMessage,
  MessagingProvider,
  MessagingProviderId,
  MessagingProviderInfo,
  OutboundMessage,
  OutboundReceipt
} from "./types.js";

export { TelegramProvider, type TelegramProviderOptions } from "./telegram-provider.js";
export { DiscordProvider, type DiscordProviderOptions } from "./discord-provider.js";
export { SlackProvider, type SlackProviderOptions } from "./slack-provider.js";
export { LineProvider, type LineProviderOptions } from "./line-provider.js";
export { LogMessagingProvider, type LogMessagingProviderOptions } from "./log-provider.js";
export {
  MacosNotificationProvider,
  type MacosNotificationProviderOptions,
  type OsascriptRunner,
  type OsascriptRunResult
} from "./macos-notification-provider.js";

export { validateOutboundMessage } from "./validate.js";

export {
  appendInbound,
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
  writeInboxInjectionCursor
} from "./inbox-injection-cursor.js";

export {
  FileBackedInboxContextProvider,
  filterFresh,
  type FileBackedInboxContextProviderOptions,
  type InboxSourceConfig,
  type InboxSnapshot as MessagingInboxSnapshot,
  type InboundSummary
} from "./inbox-surface.js";
