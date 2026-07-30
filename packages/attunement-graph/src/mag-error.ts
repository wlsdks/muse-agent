export type MagErrorCode =
  | "CLOSED"
  | "INVALID_INPUT"
  | "INVALID_SCOPE"
  | "CORRUPT_STORE"
  | "FUTURE_STORE_STATE"
  | "SNAPSHOT_CONFLICT"
  | "SNAPSHOT_SCOPE_MISMATCH"
  | "STORE_FAILURE"
  | "UNSUPPORTED_STORE_PROFILE"
  | "UNSUPPORTED_OPERATOR";

export class MagError extends Error {
  readonly code: MagErrorCode;

  constructor(code: MagErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MagError";
    this.code = code;
  }
}
