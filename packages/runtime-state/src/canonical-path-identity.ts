import { realpath, stat } from "node:fs/promises";

/** Accept native Windows aliases only when both spellings resolve to one entry. */
export async function hasCanonicalPathIdentity(path: string): Promise<boolean> {
  const canonical = await realpath(path);
  if (canonical === path) return true;
  if (process.platform !== "win32") return false;

  const [requested, resolved] = await Promise.all([stat(path), stat(canonical)]);
  return requested.dev === resolved.dev
    && requested.ino === resolved.ino
    && requested.isDirectory() === resolved.isDirectory()
    && requested.isFile() === resolved.isFile();
}
