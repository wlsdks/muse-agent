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

export { validateOutboundMessage } from "./validate.js";
