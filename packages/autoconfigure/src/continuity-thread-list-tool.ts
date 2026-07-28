import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

const THREAD_ID = /^thread_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const MAX_THREADS = 50;
const MAX_TITLE_LENGTH = 500;

export interface ContinuityThreadListSource {
  readonly id: string;
  readonly kind: "life" | "work";
  readonly title: string;
}

export interface ContinuityThreadListToolDeps {
  readonly readThreads: () => Promise<readonly ContinuityThreadListSource[]>;
}

function assertEmptyInput(args: JsonObject): void {
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("continuity thread list input must be a plain object");
  }
  if (Reflect.ownKeys(args).length !== 0) {
    throw new Error("continuity thread list accepts no arguments");
  }
}

function projectThread(
  value: ContinuityThreadListSource,
  index: number,
  seenIds: Set<string>
): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`continuity thread ${index.toString()} must be an object`);
  }
  const { id, kind, title } = value;
  if (typeof id !== "string" || !THREAD_ID.test(id)) {
    throw new Error(`continuity thread ${index.toString()} has an invalid exact id`);
  }
  if (seenIds.has(id)) {
    throw new Error(`continuity thread source contains duplicate id '${id}'`);
  }
  seenIds.add(id);
  if (kind !== "life" && kind !== "work") {
    throw new Error(`continuity thread ${index.toString()} has an invalid kind`);
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error(`continuity thread ${index.toString()} has an invalid title`);
  }
  const titleCharacters = Array.from(title);
  return {
    id,
    kind,
    title: titleCharacters.length <= MAX_TITLE_LENGTH
      ? title
      : `${titleCharacters.slice(0, MAX_TITLE_LENGTH - 1).join("")}…`
  };
}

/**
 * Read-only normal-chat seam for explicit PersonalThread selection.
 *
 * Listing is not selection authority and cannot create a thread, link an
 * artifact, preview/open a Pack, or record an outcome.
 */
export function createContinuityThreadListTool(
  deps: ContinuityThreadListToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "List existing Personal Continuity threads so the user can explicitly choose one by exact ID. Read-only: this tool does not create/select a thread, infer life vs work, link an item, preview or open a Continuity Pack, record an outcome, or grant permission for any later action.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object"
      },
      keywords: [
        "continuity",
        "personal thread",
        "unfinished",
        "resume",
        "continue",
        "이어",
        "계속",
        "개인 스레드"
      ],
      name: "muse.continuity.threads.list",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      assertEmptyInput(args);
      const source = await deps.readThreads();
      if (!Array.isArray(source)) {
        throw new Error("continuity thread source must be an array");
      }
      const seenIds = new Set<string>();
      const threads = source
        .slice(0, MAX_THREADS)
        .map((thread, index) => projectThread(thread, index, seenIds));
      return {
        count: threads.length,
        threads,
        total: source.length,
        truncated: source.length > MAX_THREADS
      };
    }
  };
}
