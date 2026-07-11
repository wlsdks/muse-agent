import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Per-provider channel pairing: the first chat that ever talks to the
 * bot is adopted as its owner, and every other chat is refused before
 * the agent runs (a public bot handle is discoverable by anyone —
 * without this gate a stranger could converse with a personal agent).
 * `MUSE_CHANNEL_ALLOWED_CHATS` grants additional chats explicitly.
 */

interface PersistedShape {
  readonly version: 1;
  readonly owners: Readonly<Record<string, string>>;
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
 * the effective owner either way (first-writer wins on a re-read so a
 * concurrent adopt can't silently swap owners).
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
    return Object.fromEntries(
      Object.entries(parsed.owners as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
}
