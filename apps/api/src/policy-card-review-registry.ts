import type { FastifyInstance } from "fastify";

const MAX_ISSUED_REVIEWS = 20;

export interface PolicyCardReviewBinding {
  readonly draft: unknown;
  readonly evidenceCases: unknown;
  readonly opportunityId: string;
  readonly previewId: string;
  readonly replayInputHash: string;
}

export interface PolicyCardReviewRegistry {
  consume(binding: PolicyCardReviewBinding): boolean;
  matches(binding: PolicyCardReviewBinding): boolean;
  record(binding: PolicyCardReviewBinding): void;
}

const registries = new WeakMap<FastifyInstance, PolicyCardReviewRegistry>();

/**
 * Binds one read-only Policy Card response to a later explicit Apply request.
 * Entries are process-local and bounded; restart or eviction requires previewing
 * again and never grants write authority by itself.
 */
export function policyCardReviewRegistryFor(
  server: FastifyInstance
): PolicyCardReviewRegistry {
  const existing = registries.get(server);
  if (existing) return existing;
  const issued = new Map<string, string>();
  const registry: PolicyCardReviewRegistry = Object.freeze({
    consume(binding: PolicyCardReviewBinding) {
      if (!matches(issued, binding)) return false;
      return issued.delete(key(binding));
    },
    matches: (binding: PolicyCardReviewBinding) => matches(issued, binding),
    record(binding: PolicyCardReviewBinding) {
      const serialized = serialize(binding);
      if (!serialized) return;
      const bindingKey = key(binding);
      issued.delete(bindingKey);
      issued.set(bindingKey, serialized);
      while (issued.size > MAX_ISSUED_REVIEWS) {
        const oldest = issued.keys().next().value as string | undefined;
        if (!oldest) break;
        issued.delete(oldest);
      }
    }
  });
  registries.set(server, registry);
  return registry;
}

function matches(
  issued: ReadonlyMap<string, string>,
  binding: PolicyCardReviewBinding
): boolean {
  const serialized = serialize(binding);
  return serialized !== undefined && issued.get(key(binding)) === serialized;
}

function key(binding: PolicyCardReviewBinding): string {
  return `${binding.opportunityId}:${binding.previewId}:${binding.replayInputHash}`;
}

function serialize(binding: PolicyCardReviewBinding): string | undefined {
  try {
    return JSON.stringify([
      binding.opportunityId,
      binding.draft,
      binding.evidenceCases,
      binding.previewId,
      binding.replayInputHash
    ]);
  } catch {
    return undefined;
  }
}
