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
 * Diagnostic snapshot returned by
 * `listEventsWithDiagnostics`. Lets callers see which providers
 * fell back (typically a remote Google / CalDAV failure that
 * the registry silently swallowed for the simple `listEvents`
 * caller).
 */
export interface CalendarListEventsDiagnostics {
  readonly events: readonly CalendarEvent[];
  readonly failedProviders: readonly { readonly providerId: string; readonly message: string }[];
}

export interface CalendarProviderRegistryOptions {
  /**
   * Optional callback invoked once per failed
   * provider on `listEvents`. The registry already swallows the
   * error so other providers (notably the local file) still
   * yield events; this hook lets a daemon log "(gcal failed —
   * falling back to local: <reason>)" without changing the
   * return shape.
   */
  readonly onProviderError?: (providerId: string, message: string) => void;
}

/**
 * Holds the set of active calendar providers and routes per-provider
 * operations. The registry is a small fan-out: every "list events"
 * call hits each provider in parallel and concatenates the results
 * tagged with `providerId`. Mutations require a single provider id.
 */
export class CalendarProviderRegistry {
  private readonly providers = new Map<string, CalendarProvider>();
  private readonly onProviderError?: (providerId: string, message: string) => void;

  constructor(
    providers: Iterable<CalendarProvider> = [],
    options: CalendarProviderRegistryOptions = {}
  ) {
    for (const provider of providers) {
      this.register(provider);
    }
    if (options.onProviderError) {
      this.onProviderError = options.onProviderError;
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
        `Calendar provider not registered: ${providerId}${registeredHint([...this.providers.keys()])}`
      );
    }

    return provider;
  }

  async listEvents(range: CalendarRange, providerId?: string): Promise<readonly CalendarEvent[]> {
    if (providerId) {
      return this.require(providerId).listEvents(range);
    }
    return (await this.listEventsWithDiagnostics(range)).events;
  }

  /**
   * Same fan-out as `listEvents` but returns a richer
   * payload that names which providers failed. Useful for daemons
   * that want to log "(gcal failed — falling back to local)"
   * instead of silently dropping the upstream error.
   */
  async listEventsWithDiagnostics(range: CalendarRange): Promise<CalendarListEventsDiagnostics> {
    const failedProviders: { providerId: string; message: string }[] = [];
    const buckets = await Promise.all(
      this.list().map(async (provider) => {
        try {
          return await provider.listEvents(range);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          failedProviders.push({ providerId: provider.id, message });
          this.onProviderError?.(provider.id, message);
          return [] as readonly CalendarEvent[];
        }
      })
    );
    const events = buckets.flat().sort(compareCalendarEvents);
    return { events, failedProviders };
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
    const trimmed = providerId?.trim();
    // A local model with no provider list often invents a sentinel like
    // "default"/"primary" to mean "my main calendar". Treat those (and blank)
    // as "use primary" so a valid create doesn't fail on a hallucinated id;
    // a concrete unknown id (e.g. "google" when only "local" exists) still
    // errors rather than silently writing to the wrong calendar.
    if (trimmed && trimmed.toLowerCase() !== "default" && trimmed.toLowerCase() !== "primary") {
      return this.require(trimmed);
    }

    const primary = this.primary();

    if (!primary) {
      throw new CalendarProviderError("", "NO_PROVIDERS", "No calendar provider is registered");
    }

    return primary;
  }
}

function registeredHint(ids: readonly string[]): string {
  return ids.length > 0 ? ` (registered: ${ids.join(", ")})` : " (none registered)";
}

export function compareCalendarEvents(left: CalendarEvent, right: CalendarEvent): number {
  return (
    left.startsAt.getTime() - right.startsAt.getTime()
    || left.providerId.localeCompare(right.providerId)
    || left.id.localeCompare(right.id)
  );
}
