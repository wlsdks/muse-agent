import { MessagingValidationError } from "./errors.js";
import type { OutboundMessage } from "./types.js";

const MAX_TEXT_LENGTH = 4096;

export function validateOutboundMessage(message: OutboundMessage): void {
  if (!message || typeof message.destination !== "string" || message.destination.trim().length === 0) {
    throw new MessagingValidationError("destination", "destination must be a non-empty string");
  }
  if (typeof message.text !== "string" || message.text.length === 0) {
    throw new MessagingValidationError("text", "text must be a non-empty string");
  }
  if (message.text.length > MAX_TEXT_LENGTH) {
    throw new MessagingValidationError("text", `text must be at most ${MAX_TEXT_LENGTH} characters`);
  }
}
