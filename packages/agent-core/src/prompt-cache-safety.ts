/**
 * Pre-provider message sanitizer (iter 10).
 *
 * `MUSE_CACHE_BOUNDARY_MARKER` is a textual split-point that
 * `buildSystemPrompt({ includeCacheBoundary: true })` injects so a
 * future provider adapter can place a real cache-control directive
 * (Anthropic `cache_control: { type: "ephemeral" }` or similar) at
 * that exact byte offset.
 *
 * No adapter consumes the marker yet, but `composeSurfacePrompt` sets
 * `includeCacheBoundary: true` unconditionally, so EVERY composed system
 * prompt carries it. Without this strip the raw
 * `<!-- MUSE_CACHE_BOUNDARY -->` text ships to the model — internal
 * metadata the model can see and echo, on every turn, on every surface.
 *
 * This module was deleted once (e96a73cae) on the reasoning that the
 * dormancy was "structural, not transitional". 917f07fc1 then turned the
 * flag on for every surface and invalidated that premise. Do not delete it
 * again while `composeSurfacePrompt` emits the marker: the correct
 * retirement is an adapter that CONSUMES the boundary
 * (`splitPromptCacheBoundary`) placing a real cache-control directive.
 *
 * This module is the safety net: strip the marker from every message
 * just before the request reaches the provider. The split helper
 * (`splitPromptCacheBoundary`) still exposes the boundary position
 * for a future adapter that wants to use it.
 */

import { stripPromptCacheBoundary } from "@muse/prompts";
import type { ModelMessage, ModelRequest } from "@muse/model";

/**
 * Return a `ModelRequest` whose messages have the cache-boundary
 * marker stripped. Pure function — does not mutate the input.
 * Skips the allocation when no message contains the marker.
 */
export function sanitizeRequestForProvider(request: ModelRequest): ModelRequest {
  const sanitized = sanitizeMessagesForProvider(request.messages);
  return sanitized === request.messages ? request : { ...request, messages: sanitized };
}

export function sanitizeMessagesForProvider(
  messages: readonly ModelMessage[]
): readonly ModelMessage[] {
  let dirty = false;
  const out = messages.map((message) => {
    const stripped = stripPromptCacheBoundary(message.content);
    if (stripped === message.content) {
      return message;
    }
    dirty = true;
    return { ...message, content: stripped };
  });
  return dirty ? out : messages;
}
