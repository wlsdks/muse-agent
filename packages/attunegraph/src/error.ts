export type AttuneGraphDataErrorCode =
  | "ASSERTION_COLLISION"
  | "INVALID_ASSERTION"
  | "INVALID_FORGET_SCOPE"
  | "INVALID_QUERY";

export class AttuneGraphDataError extends Error {
  readonly code: AttuneGraphDataErrorCode;

  constructor(code: AttuneGraphDataErrorCode, message: string) {
    super(message);
    this.name = "AttuneGraphDataError";
    this.code = code;
  }
}
