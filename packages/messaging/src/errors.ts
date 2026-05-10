export type MessagingErrorCode =
  | "PROVIDER_NOT_FOUND"
  | "NO_PROVIDERS"
  | "INVALID_DESTINATION"
  | "INVALID_TEXT"
  | "UPSTREAM_FAILED";

export class MessagingProviderError extends Error {
  readonly providerId: string;
  readonly code: MessagingErrorCode;
  readonly status?: number;

  constructor(providerId: string, code: MessagingErrorCode, message: string, status?: number) {
    super(message);
    this.name = "MessagingProviderError";
    this.providerId = providerId;
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

export class MessagingValidationError extends Error {
  readonly field: "destination" | "text";

  constructor(field: "destination" | "text", message: string) {
    super(message);
    this.name = "MessagingValidationError";
    this.field = field;
  }
}
