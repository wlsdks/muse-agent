/**
 * Shared corrupt-store quarantine for the personal sidecar stores.
 *
 * A store file that fails to parse is renamed aside to `<file>.corrupt-<ts>`
 * rather than deleted — the bytes stay on disk for forensics/recovery, and
 * the caller's read degrades to empty either way.
 */

import { quarantineCorruptFile } from "@muse/shared";

/** Backward-compatible store-layer name for the shared recovery primitive. */
export async function quarantineCorruptStore(file: string): Promise<void> {
  await quarantineCorruptFile(file);
}
