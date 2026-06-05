export interface CalendarEvent {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly allDay: boolean;
  readonly location?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
  readonly url?: string;
  readonly raw?: unknown;
  /** Raw iCalendar RRULE (e.g. "FREQ=WEEKLY;BYDAY=MO") when the event recurs. */
  readonly recurrence?: string;
}

export interface CalendarEventInput {
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly allDay?: boolean;
  readonly location?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
  /** Raw iCalendar RRULE (e.g. "FREQ=WEEKLY") to create a recurring event. */
  readonly recurrence?: string;
}

export interface CalendarEventUpdate {
  readonly title?: string;
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly allDay?: boolean;
  readonly location?: string | null;
  readonly notes?: string | null;
  readonly tags?: readonly string[] | null;
}

export interface CalendarRange {
  readonly from: Date;
  readonly to: Date;
}

export interface CredentialRequirement {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly secret: boolean;
}

export interface CalendarProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly local: boolean;
  readonly credentials: readonly CredentialRequirement[];
}

export interface CalendarProvider {
  readonly id: string;
  describe(): CalendarProviderInfo;
  listEvents(range: CalendarRange): Promise<readonly CalendarEvent[]>;
  createEvent(input: CalendarEventInput): Promise<CalendarEvent>;
  updateEvent(id: string, input: CalendarEventUpdate): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}
