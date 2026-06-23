/**
 * Stale inline-image stripping for conversation history.
 *
 * Vision turns carry multi-MB base64 image bytes inline
 * (`attachment.dataBase64`). Those bytes are re-shipped to the model
 * on EVERY subsequent turn — a silent payload/latency multiplier that
 * hits a local vision model hardest, and the token estimator doesn't
 * even count them. Once the user has moved past an image, the model
 * rarely needs the pixels again; the fact that an image WAS there is
 * what matters.
 *
 * This deterministic pass drops inline image bytes from turns BEFORE
 * the last user message (the "stale" history), replacing each with a
 * short textual placeholder so the model still knows an image was
 * present. Images in the current turn (the last user message onward)
 * are untouched, so an in-progress comparison keeps its pixels. URL
 * attachments are cheap refs, not inline bytes, so they are kept.
 *
 * Pure: no I/O, returns the ORIGINAL array reference unchanged when
 * nothing is stripped (the no-op safety property).
 *
 * Reference-only inspiration from openclaw/hermes media-stripping
 * during compaction; Muse's own, boundary-anchored implementation.
 */

import type { ConversationMessage } from "./index.js";

export interface StripStaleImagesResult {
  readonly messages: readonly ConversationMessage[];
  /** How many inline image attachments were dropped. */
  readonly strippedCount: number;
}

function isInlineImage(mimeType: string, dataBase64: string | undefined): boolean {
  return typeof dataBase64 === "string" && dataBase64.length > 0 && mimeType.toLowerCase().startsWith("image/");
}

function lastUserIndex(messages: readonly ConversationMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

function approxKb(base64: string): number {
  // base64 encodes 3 bytes per 4 chars; KB = bytes / 1024.
  return Math.max(1, Math.round((base64.length * 0.75) / 1024));
}

export function stripStaleImageAttachments(
  messages: readonly ConversationMessage[]
): StripStaleImagesResult {
  const boundary = lastUserIndex(messages);
  // No user message yet → nothing is "stale"; conservative no-op.
  if (boundary <= 0) {
    return { messages, strippedCount: 0 };
  }

  let strippedCount = 0;
  const out: ConversationMessage[] = [];
  let mutated = false;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as ConversationMessage;
    // Only history strictly before the current (last user) turn is stale.
    if (i >= boundary || !message.attachments || message.attachments.length === 0) {
      out.push(message);
      continue;
    }

    const kept: typeof message.attachments[number][] = [];
    const notes: string[] = [];
    for (const attachment of message.attachments) {
      if (isInlineImage(attachment.mimeType, attachment.dataBase64)) {
        strippedCount++;
        notes.push(`[image omitted: ${attachment.mimeType} ~${approxKb(attachment.dataBase64 as string)}KB]`);
      } else {
        kept.push(attachment);
      }
    }

    if (notes.length === 0) {
      out.push(message);
      continue;
    }

    mutated = true;
    const content = notes.length > 0 ? `${message.content}${message.content ? "\n" : ""}${notes.join("\n")}` : message.content;
    const next: ConversationMessage = kept.length > 0
      ? { ...message, attachments: kept, content }
      : // drop the now-empty attachments field entirely
        (() => {
          const { attachments: _dropped, ...rest } = message;
          return { ...rest, content };
        })();
    out.push(next);
  }

  return mutated ? { messages: out, strippedCount } : { messages, strippedCount: 0 };
}
