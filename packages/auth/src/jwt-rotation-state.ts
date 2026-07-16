/**
 * The persisted contract for a JWT signing-key rotation. File access belongs
 * to the caller; this module owns only the provider-neutral JSON boundary.
 */

export interface JwtPreviousSecret {
  readonly secret: string;
  readonly rotatedAt: string;
  readonly validUntil: string;
}

export interface JwtRotationState {
  readonly current: string;
  readonly rotatedAt: string;
  readonly previous: readonly JwtPreviousSecret[];
}

export function parseJwtRotationState(value: unknown): JwtRotationState | undefined {
  if (!value || typeof value !== "object") return undefined;

  const candidate = value as Partial<JwtRotationState>;
  if (!isJwtSecret(candidate.current) || !isIsoTimestamp(candidate.rotatedAt)) return undefined;

  const previousRaw = Array.isArray(candidate.previous) ? candidate.previous : [];
  const previous: JwtPreviousSecret[] = [];
  for (const entry of previousRaw) {
    if (!entry || typeof entry !== "object") continue;
    const candidateEntry = entry as Partial<JwtPreviousSecret>;
    if (!isJwtSecret(candidateEntry.secret)) continue;
    if (!isIsoTimestamp(candidateEntry.rotatedAt) || !isIsoTimestamp(candidateEntry.validUntil)) continue;
    previous.push({
      secret: candidateEntry.secret,
      rotatedAt: candidateEntry.rotatedAt,
      validUntil: candidateEntry.validUntil
    });
  }

  return { current: candidate.current, rotatedAt: candidate.rotatedAt, previous };
}

function isJwtSecret(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
