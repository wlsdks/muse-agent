import { promises as fs } from "node:fs";

/**
 * Move a present-but-corrupt store aside to `<file>.corrupt-<ts>` so the next
 * write starts fresh WITHOUT permanently destroying the user's prior data — a
 * corrupt read otherwise degrades to empty and the following write would
 * overwrite the only copy. Best-effort: the read degrades to empty either way.
 */
export async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty regardless
  }
}
