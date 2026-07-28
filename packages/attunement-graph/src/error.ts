export type AttunementGraphErrorCode =
  | "ASSERTION_COLLISION"
  | "INVALID_ASSERTION"
  | "INVALID_FORGET_SCOPE"
  | "INVALID_QUERY";

export class AttunementGraphError extends Error {
  readonly code: AttunementGraphErrorCode;

  constructor(code: AttunementGraphErrorCode, message: string) {
    super(message);
    this.name = "AttunementGraphError";
    this.code = code;
  }
}
