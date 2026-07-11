/**
 * Shared corrupt-store quarantine for the personal sidecar stores.
 *
 * A store file that fails to parse is renamed aside to `<file>.corrupt-<ts>`
 * rather than deleted — the bytes stay on disk for forensics/recovery, and
 * the caller's read degrades to empty either way.
 */

import { promises as fs } from "node:fs";

export async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
}
