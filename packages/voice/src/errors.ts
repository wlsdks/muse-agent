export class VoiceValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VoiceValidationError";
    this.code = code;
  }
}

export class VoiceProviderError extends Error {
  readonly providerId: string;
  readonly code: string;
  override readonly cause?: unknown;

  constructor(providerId: string, code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "VoiceProviderError";
    this.providerId = providerId;
    this.code = code;
    this.cause = cause;
  }
}
