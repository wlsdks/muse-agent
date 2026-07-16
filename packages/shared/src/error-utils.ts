function messageFromCause(cause: unknown): string | undefined {
  if (typeof cause === "string") {
    return cause;
  }

  if (cause !== null && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }

  return undefined;
}

/** Extract a useful message from an unknown thrown value. */
export function errorMessage(cause: unknown, fallback?: string): string {
  return messageFromCause(cause) ?? fallback ?? String(cause);
}

/** Safely recognize native and cross-realm error-like values. */
export function isErrorLike(value: unknown): value is Error {
  if (value instanceof Error) {
    return true;
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return ("name" in value && "message" in value) && typeof (value as { name: unknown }).name === "string" && typeof (value as { message: unknown }).message === "string";
}

/** Normalize an unknown thrown value into an Error instance. */
export function asError(error: unknown): Error {
  return isErrorLike(error) ? error : new Error(errorMessage(error));
}
