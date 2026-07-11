import { findSecretsForGuard } from "./secret-patterns.js";

/**
 * Fail-close gate for any tool that persists user-authored free text to an
 * UNENCRYPTED store (notes, tasks, reminders, remembered facts). Deterministic
 * — no LLM — and reuses `findSecrets`'s pattern list (see secret-patterns.ts)
 * so this can never drift from what `redactSecretsInText` already detects.
 *
 * This is a REFUSAL, not a mask: a persistence tool that gets `safe: false`
 * MUST NOT perform the write at all. Redaction (replacing the value with a
 * placeholder and writing THAT) is the wrong call here — a note that reads
 * "password: [redacted-credential-label]" still tells the user Muse silently
 * kept something, and offers no path to actually store the credential
 * safely. Refusing + naming the real safe alternative is the honest answer.
 */
export interface SecretPersistenceSafe {
  readonly safe: true;
}

export interface SecretPersistenceBlocked {
  readonly safe: false;
  /** Unique pattern names that matched (e.g. "credential-label", "openai-key"). */
  readonly kinds: readonly string[];
  /** Korean-first, user-facing refusal notice — pass this straight through as the tool's `error`. */
  readonly notice: string;
}

export type SecretPersistenceGuardResult = SecretPersistenceSafe | SecretPersistenceBlocked;

/**
 * `muse secrets` is not a real command and Muse has no interactive vault UI —
 * pointing at one would invent a capability. macOS Keychain Access is the
 * real, already-available place for a user to stash an arbitrary secret;
 * `@muse/secrets`'s keychain source already reads FROM the OS keychain for
 * Muse's own resolved credentials, so this is consistent with what exists,
 * not aspirational.
 */
export const SECRET_PERSISTENCE_NOTICE =
  "비밀번호·토큰·API 키 같은 민감한 값은 평문 저장소에 기록하지 않아요 (이 저장소는 암호화되지 않습니다). " +
  "macOS 키체인(Keychain Access) 같은 안전한 곳에 저장해 주세요.";

export function guardSecretPersistence(text: string): SecretPersistenceGuardResult {
  if (typeof text !== "string" || text.length === 0) {
    return { safe: true };
  }
  const matches = findSecretsForGuard(text);
  if (matches.length === 0) {
    return { safe: true };
  }
  return {
    kinds: [...new Set(matches.map((match) => match.kind))],
    notice: SECRET_PERSISTENCE_NOTICE,
    safe: false
  };
}
