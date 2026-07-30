export type AttuneGraphErrorCode =
  | "CLOSED"
  | "INVALID_INPUT"
  | "INVALID_SCOPE"
  | "CORRUPT_STORE"
  | "FUTURE_STORE_STATE"
  | "INCOMPATIBLE_STORE_PROFILE"
  | "SNAPSHOT_CONFLICT"
  | "SNAPSHOT_SCOPE_MISMATCH"
  | "STORE_FAILURE"
  | "UNSUPPORTED_STORE_PROFILE"
  | "UNSUPPORTED_OPERATOR";

export class AttuneGraphError extends Error {
  readonly code: AttuneGraphErrorCode;

  constructor(code: AttuneGraphErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttuneGraphError";
    this.code = code;
  }
}
