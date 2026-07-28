import { createHash, timingSafeEqual } from "node:crypto";

import type {
  ContinuityDelivery,
  ContinuityEvidence,
  ContinuityPack
} from "@muse/attunement";
import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

const THREAD_ID_PATTERN = /^thread_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_EVIDENCE = 50;
const MAX_TITLE_CHARACTERS = 300;
const MAX_SUMMARY_CHARACTERS = 240;

export interface ContinuityPackToolDeps {
  readonly openPack: (
    threadId: string
  ) => Promise<{ readonly delivery: ContinuityDelivery; readonly pack: ContinuityPack }>;
  readonly previewPack: (threadId: string) => Promise<ContinuityPack>;
}

function parseInput(
  args: JsonObject,
  open: false
): { readonly threadId: string };
function parseInput(
  args: JsonObject,
  open: true
): { readonly previewDigest: string; readonly threadId: string };
function parseInput(
  args: JsonObject,
  open: boolean
): { readonly previewDigest?: string; readonly threadId: string } {
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("continuity Pack input must be a plain object");
  }
  const required = open
    ? ["previewDigest", "threadId"] as const
    : ["threadId"] as const;
  const keys = Reflect.ownKeys(args);
  if (
    keys.length !== required.length
    || keys.some((key) => typeof key !== "string")
    || required.some((key) => !keys.includes(key))
  ) {
    throw new Error(`continuity Pack requires exactly ${required.join(", ")}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(args);
  const threadDescriptor = descriptors["threadId"];
  if (!threadDescriptor || !("value" in threadDescriptor)) {
    throw new Error("continuity Pack threadId must be a plain data property");
  }
  const threadId = threadDescriptor.value;
  if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) {
    throw new Error("continuity Pack requires a full exact threadId");
  }
  if (!open) return { threadId };
  const digestDescriptor = descriptors["previewDigest"];
  if (!digestDescriptor || !("value" in digestDescriptor)) {
    throw new Error("continuity Pack previewDigest must be a plain data property");
  }
  const previewDigest = digestDescriptor.value;
  if (typeof previewDigest !== "string" || !DIGEST_PATTERN.test(previewDigest)) {
    throw new Error("continuity Pack open requires the exact previewDigest");
  }
  return { previewDigest, threadId };
}

function bounded(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length <= max
    ? value
    : `${characters.slice(0, max - 1).join("")}…`;
}

function projectEvidence(entry: ContinuityEvidence): JsonObject {
  const artifact = entry.artifact;
  return {
    reference: {
      artifactId: entry.reference.artifactId,
      artifactType: entry.reference.artifactType,
      providerId: entry.reference.providerId,
      role: entry.reference.role
    },
    status: entry.status,
    ...(artifact ? {
      artifact: {
        ...(artifact.summary
          ? { summary: bounded(artifact.summary, MAX_SUMMARY_CHARACTERS) }
          : {}),
        ...(artifact.taskDueAt ? { taskDueAt: artifact.taskDueAt } : {}),
        ...(artifact.taskDueState ? { taskDueState: artifact.taskDueState } : {}),
        ...(artifact.taskStatus ? { taskStatus: artifact.taskStatus } : {}),
        title: bounded(artifact.title, MAX_TITLE_CHARACTERS)
      }
    } : {})
  };
}

function projectPack(pack: ContinuityPack): JsonObject {
  const evidence = pack.evidence.slice(0, MAX_EVIDENCE).map(projectEvidence);
  return {
    deliveryPolicyVersion: pack.deliveryPolicyVersion,
    evidence,
    evidenceCount: evidence.length,
    totalEvidence: pack.evidence.length,
    thread: {
      id: pack.thread.id,
      kind: pack.thread.kind,
      title: bounded(pack.thread.title, MAX_TITLE_CHARACTERS)
    },
    truncated: pack.evidence.length > MAX_EVIDENCE
  };
}

function packDigest(pack: JsonObject): string {
  return createHash("sha256").update(JSON.stringify([
    "muse.continuity.pack.preview.v1",
    pack
  ])).digest("hex");
}

function digestMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function inspectPack(
  deps: ContinuityPackToolDeps,
  threadId: string
): Promise<{ readonly digest: string; readonly pack: JsonObject }> {
  const pack = projectPack(await deps.previewPack(threadId));
  return { digest: packDigest(pack), pack };
}

function inputSchema(open: boolean): JsonObject {
  return {
    additionalProperties: false,
    properties: {
      ...(open ? { previewDigest: {
        description: "Exact SHA-256 digest returned by the matching Pack preview.",
        maxLength: 64,
        minLength: 64,
        pattern: "^[a-f0-9]{64}$",
        type: "string"
      } } : {}),
      threadId: {
        description: "Full exact Personal Continuity thread ID.",
        maxLength: 263,
        minLength: 8,
        type: "string"
      }
    },
    required: open ? ["previewDigest", "threadId"] : ["threadId"],
    type: "object"
  };
}

export function createContinuityPackPreviewTool(
  deps: ContinuityPackToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Preview a bounded Personal Continuity Pack for one exact thread. Read-only: it resolves current exact linked evidence and returns a digest, but never opens the Pack, creates a delivery receipt, records an outcome, or grants later authority.",
      domain: "core",
      inputSchema: inputSchema(false),
      keywords: [
        "continuity",
        "pack preview",
        "resume context",
        "이어보기",
        "팩 미리보기"
      ],
      name: "muse.continuity.pack.preview",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const { threadId } = parseInput(args, false);
      const preview = await inspectPack(deps, threadId);
      return {
        mutation: false,
        pack: preview.pack,
        previewDigest: preview.digest
      };
    }
  };
}

export function createContinuityPackOpenTool(
  deps: ContinuityPackToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Request explicit owner approval to open one previously previewed Personal Continuity Pack. Revalidates the exact thread and preview digest at execution time, then uses the shared Attunement store to create exactly one delivery receipt. It never records an outcome or changes linked sources or policy.",
      domain: "core",
      inputSchema: inputSchema(true),
      keywords: [
        "continuity",
        "open pack",
        "resume",
        "팩 열기",
        "이어가기"
      ],
      name: "muse.continuity.pack.open",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const input = parseInput(args, true);
      const current = await inspectPack(deps, input.threadId);
      if (!digestMatches(input.previewDigest, current.digest)) {
        throw new Error("continuity Pack previewDigest is stale or does not match this exact Pack");
      }
      const opened = await deps.openPack(input.threadId);
      if (
        opened.delivery.threadId !== input.threadId
        || opened.pack.thread.id !== input.threadId
      ) {
        throw new Error("opened Continuity Pack did not preserve the approved exact thread");
      }
      return {
        delivery: {
          evidenceCount: opened.delivery.evidenceRefs.length,
          id: opened.delivery.id,
          openedAt: opened.delivery.openedAt,
          threadId: opened.delivery.threadId
        },
        success: true
      };
    }
  };
}
