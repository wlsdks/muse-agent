/**
 * Leaf module so `./jwt.ts` can throw without pulling in
 * `./index.ts` (which would close a cycle — index re-exports
 * JwtTokenProvider). Both sides of the auth package import from
 * here, the file itself imports nothing from `@muse/auth`.
 */

export class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}
