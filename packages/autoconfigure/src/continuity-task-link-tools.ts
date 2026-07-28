import { createHash, timingSafeEqual } from "node:crypto";

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const THREAD_ID_PATTERN = /^thread_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_TITLE_CHARACTERS = 500;
const TITLE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

export interface ContinuityTaskLinkProposal {
  readonly expectedTitle: string;
  readonly role: "context" | "next-step";
  readonly taskId: string;
  readonly threadId: string;
}

export interface ContinuityTaskLinkThreadSource {
  readonly id: string;
  readonly kind: "life" | "work";
  readonly title: string;
}

export interface ContinuityTaskLinkTaskSource {
  readonly id: string;
  readonly status: "open" | "done";
  readonly title: string;
}

export interface ContinuityTaskLinkResult {
  readonly created: boolean;
  readonly link: {
    readonly artifactId: string;
    readonly artifactType: "task";
    readonly providerId: "local";
    readonly role: "context" | "next-step";
    readonly threadId: string;
  };
}

export interface ContinuityTaskLinkToolDeps {
  readonly linkTask: (
    proposal: ContinuityTaskLinkProposal
  ) => Promise<ContinuityTaskLinkResult>;
  readonly readTask: (
    taskId: string
  ) => Promise<ContinuityTaskLinkTaskSource | undefined>;
  readonly readThread: (
    threadId: string
  ) => Promise<ContinuityTaskLinkThreadSource | undefined>;
}

interface ConfirmedContinuityTaskLinkProposal extends ContinuityTaskLinkProposal {
  readonly previewDigest: string;
}

function dataValue(
  descriptors: PropertyDescriptorMap,
  key: keyof ConfirmedContinuityTaskLinkProposal
): unknown {
  const descriptor = descriptors[key];
  if (!descriptor || !("value" in descriptor)) {
    throw new Error(`continuity task link ${key} must be a plain data property`);
  }
  return descriptor.value;
}

function parseProposal(
  args: JsonObject,
  confirm: false
): ContinuityTaskLinkProposal;
function parseProposal(
  args: JsonObject,
  confirm: true
): ConfirmedContinuityTaskLinkProposal;
function parseProposal(
  args: JsonObject,
  confirm: boolean
): ContinuityTaskLinkProposal | ConfirmedContinuityTaskLinkProposal {
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("continuity task link input must be a plain object");
  }
  const required = confirm
    ? ["expectedTitle", "previewDigest", "role", "taskId", "threadId"] as const
    : ["expectedTitle", "role", "taskId", "threadId"] as const;
  const keys = Reflect.ownKeys(args);
  if (
    keys.length !== required.length
    || keys.some((key) => typeof key !== "string")
    || required.some((key) => !keys.includes(key))
  ) {
    throw new Error(
      `continuity task link requires exactly ${required.join(", ")}`
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(args);
  const expectedTitle = dataValue(descriptors, "expectedTitle");
  const role = dataValue(descriptors, "role");
  const taskId = dataValue(descriptors, "taskId");
  const threadId = dataValue(descriptors, "threadId");
  if (
    typeof expectedTitle !== "string"
    || expectedTitle.length === 0
    || expectedTitle !== expectedTitle.trim()
    || Array.from(expectedTitle).length > MAX_TITLE_CHARACTERS
    || TITLE_CONTROL_CHARACTERS.test(expectedTitle)
  ) {
    throw new Error(
      "continuity task expectedTitle must be 1-500 characters with no surrounding whitespace or control characters"
    );
  }
  if (role !== "context" && role !== "next-step") {
    throw new Error("continuity task link role must be exactly context or next-step");
  }
  if (typeof taskId !== "string" || !ID_PATTERN.test(taskId)) {
    throw new Error("continuity task link requires a full canonical taskId");
  }
  if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) {
    throw new Error("continuity task link requires a full canonical threadId");
  }
  const base: ContinuityTaskLinkProposal = { expectedTitle, role, taskId, threadId };
  if (!confirm) return base;
  const previewDigest = dataValue(descriptors, "previewDigest");
  if (typeof previewDigest !== "string" || !DIGEST_PATTERN.test(previewDigest)) {
    throw new Error("continuity task link requires the exact previewDigest");
  }
  return { ...base, previewDigest };
}

function proposalDigest(proposal: ContinuityTaskLinkProposal): string {
  return createHash("sha256").update(JSON.stringify([
    "muse.continuity.task.link.v1",
    proposal.threadId,
    proposal.taskId,
    proposal.expectedTitle,
    proposal.role
  ])).digest("hex");
}

function digestMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function inspectProposal(
  deps: ContinuityTaskLinkToolDeps,
  proposal: ContinuityTaskLinkProposal
): Promise<JsonObject> {
  const [thread, task] = await Promise.all([
    deps.readThread(proposal.threadId),
    deps.readTask(proposal.taskId)
  ]);
  if (!thread || thread.id !== proposal.threadId) {
    throw new Error(`no Personal Continuity thread with exact id '${proposal.threadId}'`);
  }
  if (!task || task.id !== proposal.taskId) {
    throw new Error(`no local task with exact canonical id '${proposal.taskId}'`);
  }
  if (task.title !== proposal.expectedTitle) {
    throw new Error(
      `local task '${proposal.taskId}' was renamed; preview it again with the current exact title`
    );
  }
  if (proposal.role === "next-step" && task.status !== "open") {
    throw new Error("only an open local task can be linked as a next-step");
  }
  return {
    mutation: false,
    previewDigest: proposalDigest(proposal),
    proposedLink: {
      artifactId: task.id,
      artifactType: "task",
      providerId: "local",
      role: proposal.role,
      threadId: thread.id
    },
    task: {
      id: task.id,
      status: task.status,
      title: task.title
    },
    thread: {
      id: thread.id,
      kind: thread.kind,
      title: thread.title
    }
  };
}

function proposalInputSchema(confirm: boolean): JsonObject {
  const properties: JsonObject = {
    expectedTitle: {
      description:
        "Exact current task title copied from the task result. A rename requires a new preview.",
      maxLength: MAX_TITLE_CHARACTERS,
      minLength: 1,
      type: "string"
    },
    role: {
      description: "context, or next-step for an open task.",
      enum: ["context", "next-step"],
      type: "string"
    },
    taskId: {
      description:
        "Full canonical local task ID. Prefixes and task titles are not accepted.",
      maxLength: 256,
      minLength: 1,
      type: "string"
    },
    threadId: {
      description: "Full exact Personal Continuity thread ID from the thread list tool.",
      maxLength: 263,
      minLength: 8,
      type: "string"
    },
    ...(confirm ? { previewDigest: {
      description: "Exact SHA-256 digest returned by the matching read-only preview.",
      maxLength: 64,
      minLength: 64,
      pattern: "^[a-f0-9]{64}$",
      type: "string"
    } } : {})
  };
  return {
    additionalProperties: false,
    properties,
    required: confirm
      ? ["expectedTitle", "role", "taskId", "threadId", "previewDigest"]
      : ["expectedTitle", "role", "taskId", "threadId"],
    type: "object"
  };
}

export function createContinuityTaskLinkPreviewTool(
  deps: ContinuityTaskLinkToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Preview linking one exact local task to one exact Personal Continuity thread. Read-only: requires the full canonical task ID plus its exact current title, rejects prefix/title lookup, rename, deletion, and ambiguity, and returns a digest-bound proposal without linking or granting approval.",
      domain: "core",
      inputSchema: proposalInputSchema(false),
      keywords: [
        "continuity",
        "task link",
        "link preview",
        "exact task",
        "작업 연결",
        "연결 미리보기"
      ],
      name: "muse.continuity.task.link.preview",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> =>
      inspectProposal(deps, parseProposal(args, false))
  };
}

export function createContinuityTaskLinkTool(
  deps: ContinuityTaskLinkToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Request approval to link one previously previewed exact local task to one exact Personal Continuity thread. Requires the unchanged preview fields and digest, revalidates task existence/title at execution time, and creates only that link after explicit owner approval. It never searches by title, changes task/thread data, opens a Pack, or records an outcome.",
      domain: "core",
      inputSchema: proposalInputSchema(true),
      keywords: [
        "continuity",
        "task link",
        "confirm link",
        "exact task",
        "작업 연결 승인"
      ],
      name: "muse.continuity.task.link",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const confirmed = parseProposal(args, true);
      const preview = await inspectProposal(deps, confirmed);
      const currentDigest = preview["previewDigest"];
      if (
        typeof currentDigest !== "string"
        || !digestMatches(confirmed.previewDigest, currentDigest)
      ) {
        throw new Error("continuity task link previewDigest does not match the exact current proposal");
      }
      const result = await deps.linkTask(confirmed);
      if (
        result.link.artifactId !== confirmed.taskId
        || result.link.artifactType !== "task"
        || result.link.providerId !== "local"
        || result.link.role !== confirmed.role
        || result.link.threadId !== confirmed.threadId
      ) {
        throw new Error("created continuity task link did not preserve the approved exact proposal");
      }
      return {
        created: result.created,
        link: {
          artifactId: result.link.artifactId,
          artifactType: result.link.artifactType,
          providerId: result.link.providerId,
          role: result.link.role,
          threadId: result.link.threadId
        },
        success: true
      };
    }
  };
}
