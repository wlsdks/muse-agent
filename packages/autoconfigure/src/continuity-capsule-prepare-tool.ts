import { types as nodeTypes } from "node:util";

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import type {
  ContinuityCapsulePreparationService
} from "./continuity-capsule-preparation-service.js";

const THREAD_ID_PATTERN =
  /^thread_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

function parseInput(
  args: JsonObject
): Readonly<{ readonly threadId: string; readonly locale: "en" | "ko" }> {
  if (
    nodeTypes.isProxy(args)
    || (Object.getPrototypeOf(args) !== Object.prototype
      && Object.getPrototypeOf(args) !== null)
  ) {
    throw new Error(
      "Continuity Capsule preparation input must be a plain object"
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(args);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2
    || keys.some((key) =>
      typeof key !== "string"
      || (key !== "threadId" && key !== "locale")
    )
  ) {
    throw new Error(
      "Continuity Capsule preparation requires exactly threadId and locale"
    );
  }
  const threadDescriptor = descriptors.threadId;
  const localeDescriptor = descriptors.locale;
  if (
    threadDescriptor === undefined
    || !("value" in threadDescriptor)
    || localeDescriptor === undefined
    || !("value" in localeDescriptor)
  ) {
    throw new Error(
      "Continuity Capsule preparation accepts only plain data properties"
    );
  }
  const threadId = threadDescriptor.value;
  const locale = localeDescriptor.value;
  if (
    typeof threadId !== "string"
    || !THREAD_ID_PATTERN.test(threadId)
    || (locale !== "en" && locale !== "ko")
  ) {
    throw new Error(
      "Continuity Capsule preparation requires an exact threadId and en or ko locale"
    );
  }
  return Object.freeze({ threadId, locale });
}

export function createContinuityCapsulePrepareTool(
  service: ContinuityCapsulePreparationService
): MuseTool {
  return {
    definition: {
      description:
        "Prepare one bounded, evidence-bound, display-only Continuity Capsule draft for an exact thread. The first call may only seed a process-local comparison baseline. The tool accepts no draft text, source IDs, model/provider, time, or action mode; it never delivers, executes, records feedback, changes policy, or grants action authority.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          locale: {
            description:
              "Deterministic system-copy locale for the Capsule.",
            enum: ["en", "ko"],
            type: "string"
          },
          threadId: {
            description:
              "Full exact Personal Continuity thread ID.",
            maxLength: 263,
            minLength: 8,
            type: "string"
          }
        },
        required: ["threadId", "locale"],
        type: "object"
      },
      keywords: [
        "continuity",
        "capsule",
        "prepare resume",
        "재개 캡슐",
        "이어갈 초안"
      ],
      name: "muse.continuity.capsule.prepare",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const input = parseInput(args);
      const result = await service.prepare(input);
      return result as unknown as JsonObject;
    }
  };
}
