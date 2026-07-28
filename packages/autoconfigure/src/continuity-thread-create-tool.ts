import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

const MAX_TITLE_CHARACTERS = 500;
const TITLE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

interface ContinuityThreadCreateInput {
  readonly kind: "life" | "work";
  readonly title: string;
}

interface CreatedContinuityThread {
  readonly id: string;
  readonly kind: "life" | "work";
  readonly links: readonly unknown[];
  readonly title: string;
}

export interface ContinuityThreadCreateToolDeps {
  readonly createThread: (
    input: ContinuityThreadCreateInput
  ) => Promise<CreatedContinuityThread>;
}

function ownDataValue(
  descriptors: PropertyDescriptorMap,
  key: "kind" | "title"
): unknown {
  const descriptor = descriptors[key];
  if (!descriptor || !("value" in descriptor)) {
    throw new Error(`continuity thread create ${key} must be a plain data property`);
  }
  return descriptor.value;
}

function parseInput(args: JsonObject): ContinuityThreadCreateInput {
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("continuity thread create input must be a plain object");
  }
  const keys = Reflect.ownKeys(args);
  if (
    keys.length !== 2
    || !keys.includes("kind")
    || !keys.includes("title")
    || keys.some((key) => typeof key !== "string")
  ) {
    throw new Error("continuity thread create requires exactly kind and title");
  }
  const descriptors = Object.getOwnPropertyDescriptors(args);
  const kind = ownDataValue(descriptors, "kind");
  const title = ownDataValue(descriptors, "title");
  if (kind !== "life" && kind !== "work") {
    throw new Error("continuity thread kind must be exactly life or work");
  }
  if (
    typeof title !== "string"
    || title.length === 0
    || title !== title.trim()
    || Array.from(title).length > MAX_TITLE_CHARACTERS
    || TITLE_CONTROL_CHARACTERS.test(title)
  ) {
    throw new Error(
      "continuity thread title must be 1-500 characters with no surrounding whitespace or control characters"
    );
  }
  return { kind, title };
}

/**
 * One write-risk workflow for proposing and explicitly confirming a thread.
 *
 * Normal chat's approval gate captures the exact kind/title as a durable
 * pending suggestion. This executor is reached only when the owner separately
 * approves that pending ID; the approval coordinator also makes replay
 * fail-closed.
 */
export function createContinuityThreadCreateTool(
  deps: ContinuityThreadCreateToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Propose creation of exactly one Personal Continuity thread with an owner-supplied life/work kind and title. In normal chat this write-risk call becomes a pending suggestion: it must not create or select a thread, infer the kind, or link anything until the owner explicitly approves the exact proposal. Returns the created thread identity after approval; linking, Pack access, and outcomes remain separate actions.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          kind: {
            description: "Exact owner-chosen thread kind. Never infer it.",
            enum: ["life", "work"],
            type: "string"
          },
          title: {
            description:
              "Exact owner-supplied title, 1-500 characters, without leading/trailing whitespace.",
            maxLength: MAX_TITLE_CHARACTERS,
            minLength: 1,
            type: "string"
          }
        },
        required: ["kind", "title"],
        type: "object"
      },
      keywords: [
        "continuity",
        "personal thread",
        "life thread",
        "work thread",
        "create thread",
        "스레드 생성",
        "생활",
        "업무"
      ],
      name: "muse.continuity.thread.create",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const input = parseInput(args);
      const thread = await deps.createThread(input);
      if (
        thread.kind !== input.kind
        || thread.title !== input.title
        || !Array.isArray(thread.links)
        || thread.links.length !== 0
      ) {
        throw new Error("created continuity thread did not preserve the approved unlinked proposal");
      }
      return {
        created: true,
        linksCreated: 0,
        success: true,
        thread: {
          id: thread.id,
          kind: thread.kind,
          title: thread.title
        }
      };
    }
  };
}
