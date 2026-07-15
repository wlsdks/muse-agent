import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomInt, timingSafeEqual } from "node:crypto";

/**
 * Per-provider channel pairing: adoption as owner requires a one-time
 * pairing code the owner reads from an authenticated surface (web
 * console / `muse messaging pairing-code`) and sends to the bot —
 * the FIRST chat to message the bot is no longer auto-adopted (a
 * public bot handle is discoverable by anyone, so TOFU let a stranger
 * who messages first claim the agent). `MUSE_CHANNEL_ALLOWED_CHATS`
 * grants additional chats explicitly once an owner is paired.
 */

interface PersistedShape {
  readonly version: 1;
  readonly owners: Readonly<Record<string, string>>;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (typeof key === "string") {
      record[key] = nestedValue;
    }
  }
  return record;
}

export function resolveChannelOwnersFile(env: { readonly [key: string]: string | undefined }): string {
  const override = env.MUSE_CHANNEL_OWNERS_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".muse", "channel-owners.json");
}

export async function readChannelOwner(file: string, providerId: string): Promise<string | undefined> {
  const owners = await readAll(file);
  return owners[providerId];
}

/**
 * Record `source` as the provider's owner IF none exists yet; returns
 * the effective owner either way. Callers gate entry to this (a valid
 * one-time pairing code, verified via `verifyPairingCodeAttempt` below)
 * — there is no re-read-after-write here, so this alone is only safe
 * under single-process sequential inbound processing, not as a
 * standalone race guard.
 */
export async function adoptChannelOwner(file: string, providerId: string, source: string): Promise<string> {
  const owners = await readAll(file);
  const existing = owners[providerId];
  if (existing) {
    return existing;
  }
  const next: PersistedShape = { owners: { ...owners, [providerId]: source }, version: 1 };
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  return source;
}

/** Clear the provider's owner so pairing can happen again with a fresh code. */
export async function removeChannelOwner(file: string, providerId: string): Promise<void> {
  const owners = await readAll(file);
  if (!(providerId in owners)) {
    return;
  }
  const { [providerId]: _dropped, ...rest } = owners;
  const next: PersistedShape = { owners: rest, version: 1 };
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Parse `provider:source` pairs from MUSE_CHANNEL_ALLOWED_CHATS ("telegram:123,matrix:!r:hs"). */
export function parseAllowedChats(raw: string | undefined): ReadonlySet<string> {
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.includes(":"))
  );
}

async function readAll(file: string): Promise<Readonly<Record<string, string>>> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as { owners?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.owners || typeof parsed.owners !== "object") {
      return {};
    }
    const owners = toRecord(parsed.owners);
    if (!owners) return {};
    return Object.fromEntries(Object.entries(owners).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/**
 * One-time pairing codes — the mechanism that replaces TOFU adoption.
 * The owner reads a provider's code from an authenticated surface (web
 * console GET /api/messaging/setup, or `muse messaging pairing-code`)
 * and sends it to the bot as a normal chat message; a match adopts the
 * sender as owner and consumes the code. A wrong guess is attempt-capped
 * so the fixed-length numeric code can't be brute-forced over chat.
 */

const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_MAX_ATTEMPTS = 5;

interface PairingCodeEntry {
  readonly code: string;
  readonly attempts: number;
  readonly createdAt: string;
}

interface PairingCodesShape {
  readonly version: 1;
  readonly codes: Readonly<Record<string, PairingCodeEntry>>;
}

export type PairingCodeVerdict = "matched" | "wrong" | "no_code";

export function resolveChannelPairingCodesFile(env: { readonly [key: string]: string | undefined }): string {
  const override = env.MUSE_CHANNEL_PAIRING_CODES_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".muse", "channel-pairing-codes.json");
}

function generatePairingCode(): string {
  // Cryptographically random, never Math.random — this is the ONLY secret
  // standing between a discoverable public bot handle and owner adoption.
  return randomInt(0, 10 ** PAIRING_CODE_LENGTH).toString().padStart(PAIRING_CODE_LENGTH, "0");
}

/**
 * The first 6-digit run in free text is the code candidate — lets the
 * owner paste "here's the code: 048213" or just "048213" and still match,
 * while an unrelated chat message ("book a flight") yields no candidate
 * at all (so it doesn't burn an attempt on ordinary conversation).
 */
export function extractPairingCodeCandidate(text: string): string | undefined {
  const match = new RegExp(`\\b\\d{${PAIRING_CODE_LENGTH}}\\b`, "u").exec(text);
  return match?.[0];
}

/**
 * Returns the provider's active pairing code, generating one if none
 * exists yet. Read-only from the caller's perspective otherwise — this
 * never resets an in-progress code's attempt counter.
 */
export async function getOrCreatePairingCode(file: string, providerId: string, now: Date): Promise<string> {
  const codes = await readAllPairingCodes(file);
  const existing = codes[providerId];
  if (existing) {
    return existing.code;
  }
  const entry: PairingCodeEntry = { attempts: 0, code: generatePairingCode(), createdAt: now.toISOString() };
  await writePairingCodes(file, { ...codes, [providerId]: entry });
  return entry.code;
}

/** Drop the provider's pairing code (e.g. alongside an owner reset) so the next read mints a fresh one. */
export async function removePairingCode(file: string, providerId: string): Promise<void> {
  const codes = await readAllPairingCodes(file);
  if (!(providerId in codes)) {
    return;
  }
  const { [providerId]: _dropped, ...rest } = codes;
  await writePairingCodes(file, rest);
}

/**
 * Verify a candidate against the provider's active code in constant time
 * (`timingSafeEqual`, fixed-length buffers so it never throws on a
 * length mismatch). A match consumes the code (single-use). A wrong
 * guess increments the attempt counter and, once it reaches
 * `PAIRING_CODE_MAX_ATTEMPTS`, deletes the code entirely — the code
 * becomes unusable (a fresh one must be regenerated) rather than staying
 * guessable forever.
 */
export async function verifyPairingCodeAttempt(
  file: string,
  providerId: string,
  candidate: string
): Promise<PairingCodeVerdict> {
  const codes = await readAllPairingCodes(file);
  const entry = codes[providerId];
  if (!entry) {
    return "no_code";
  }
  const expected = Buffer.from(entry.code, "utf8");
  const actual = Buffer.from(candidate, "utf8");
  const matched = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (matched) {
    await removePairingCode(file, providerId);
    return "matched";
  }
  const attempts = entry.attempts + 1;
  if (attempts >= PAIRING_CODE_MAX_ATTEMPTS) {
    await removePairingCode(file, providerId);
    return "wrong";
  }
  await writePairingCodes(file, { ...codes, [providerId]: { ...entry, attempts } });
  return "wrong";
}

async function readAllPairingCodes(file: string): Promise<Readonly<Record<string, PairingCodeEntry>>> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as { codes?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.codes || typeof parsed.codes !== "object") {
      return {};
    }
    const codes = toRecord(parsed.codes);
    if (!codes) return {};
    return Object.fromEntries(
      Object.entries(codes).filter((entry): entry is [string, PairingCodeEntry] => isPairingCodeEntry(entry[1]))
    );
  } catch {
    return {};
  }
}

function isPairingCodeEntry(value: unknown): value is PairingCodeEntry {
  return (
    typeof value === "object"
    && value !== null
    && typeof (value as { code?: unknown }).code === "string"
    && typeof (value as { attempts?: unknown }).attempts === "number"
    && typeof (value as { createdAt?: unknown }).createdAt === "string"
  );
}

async function writePairingCodes(file: string, codes: Readonly<Record<string, PairingCodeEntry>>): Promise<void> {
  const next: PairingCodesShape = { codes, version: 1 };
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}
