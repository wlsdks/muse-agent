import { CalendarProviderError } from "./errors.js";
import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProvider,
  CalendarProviderInfo,
  CalendarRange
} from "./types.js";

/**
 * Holds the set of active calendar providers and routes per-provider
 * operations. The registry is a small fan-out: every "list events"
 * call hits each provider in parallel and concatenates the results
 * tagged with `providerId`. Mutations require a single provider id.
 */
export class CalendarProviderRegistry {
  private readonly providers = new Map<string, CalendarProvider>();

  constructor(providers: Iterable<CalendarProvider> = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: CalendarProvider): void {
    this.providers.set(provider.id, provider);
  }

  list(): readonly CalendarProvider[] {
    return [...this.providers.values()];
  }

  describe(): readonly CalendarProviderInfo[] {
    return this.list().map((provider) => provider.describe());
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  primary(): CalendarProvider | undefined {
    return this.list()[0];
  }

  require(providerId: string): CalendarProvider {
    const provider = this.providers.get(providerId);

    if (!provider) {
      throw new CalendarProviderError(
        providerId,
        "PROVIDER_NOT_FOUND",
        `Calendar provider not registered: ${providerId}`
      );
    }

    return provider;
  }

  async listEvents(range: CalendarRange, providerId?: string): Promise<readonly CalendarEvent[]> {
    if (providerId) {
      return this.require(providerId).listEvents(range);
    }

    const buckets = await Promise.all(
      this.list().map(async (provider) => {
        try {
          return await provider.listEvents(range);
        } catch {
          return [] as readonly CalendarEvent[];
        }
      })
    );
    return buckets.flat().sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
  }

  createEvent(providerId: string | undefined, input: CalendarEventInput): Promise<CalendarEvent> {
    return this.requireOrPrimary(providerId).createEvent(input);
  }

  updateEvent(providerId: string, id: string, input: CalendarEventUpdate): Promise<CalendarEvent> {
    return this.require(providerId).updateEvent(id, input);
  }

  deleteEvent(providerId: string, id: string): Promise<void> {
    return this.require(providerId).deleteEvent(id);
  }

  private requireOrPrimary(providerId: string | undefined): CalendarProvider {
    if (providerId) {
      return this.require(providerId);
    }

    const primary = this.primary();

    if (!primary) {
      throw new CalendarProviderError("", "NO_PROVIDERS", "No calendar provider is registered");
    }

    return primary;
  }
}
