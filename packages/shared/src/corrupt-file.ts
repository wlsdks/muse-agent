import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";

/**
 * Preserves unreadable local state before a recovery path writes a replacement.
 *
 * This is deliberately best effort: another recovery worker may have already
 * moved the original file by the time this operation runs.
 */
export async function quarantineCorruptFile(file: string): Promise<void> {
  const quarantineFile = `${file}.corrupt-${Date.now().toString()}-${randomUUID()}`;
  await rename(file, quarantineFile).catch(() => undefined);
}
