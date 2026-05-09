export class CalendarValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CalendarValidationError";
    this.code = code;
  }
}

export class CalendarProviderError extends Error {
  readonly providerId: string;
  readonly code: string;
  readonly cause?: unknown;

  constructor(providerId: string, code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "CalendarProviderError";
    this.providerId = providerId;
    this.code = code;
    this.cause = cause;
  }
}
