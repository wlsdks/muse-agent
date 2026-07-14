/**
 * Which conversation `readLastChatHistory` / `appendLastChatTurn` /
 * `/resume` etc. operate on right now — a single-value pointer file
 * (`~/.muse/active-conversation.json`), separate from `conversations.json`
 * itself so switching the active conversation never touches the (larger,
 * more contention-prone) conversation store file.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isRecord } from "@muse/shared";

import { atomicWriteFile } from "./atomic-file-store.js";
import { withFileLock } from "./encrypted-file.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export function defaultActiveConversationFile(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const fromEnv = env.MUSE_ACTIVE_CONVERSATION_FILE?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".muse", "active-conversation.json");
}

export async function readActiveConversationId(file: string = defaultActiveConversationFile()): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    await quarantineCorruptStore(file);
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.activeId !== "string" || parsed.activeId.length === 0) {
    return undefined;
  }
  return parsed.activeId;
}

export async function writeActiveConversationId(id: string, file: string = defaultActiveConversationFile()): Promise<void> {
  await withFileLock(file, async () => {
    await atomicWriteFile(file, `${JSON.stringify({ activeId: id, version: 1 }, null, 2)}\n`);
  });
}
