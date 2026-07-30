import { createHash, timingSafeEqual } from "node:crypto";

import type {
  ContinuityDelivery,
  ContinuityEvidence,
  ContinuityPack
} from "@muse/attunement";
import type {
  ContinuityResumeRuntimeCapsuleRequestV1,
  ContinuityResumeRuntimeResultV1
} from "@muse/attunement-graph/continuity-resume-runtime";
import {
  presentContinuityResumeRuntimeCapsule,
  validateContinuityResumeRuntimeCapsuleRequest
} from "@muse/attunement-graph/continuity-resume-runtime";
import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

const THREAD_ID_PATTERN = /^thread_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_EVIDENCE = 50;
const MAX_TITLE_CHARACTERS = 300;
const MAX_SUMMARY_CHARACTERS = 240;

export interface ContinuityPackOpenToolDeps {
  readonly openPack: (
    threadId: string,
    runId: string
  ) => Promise<{ readonly delivery: ContinuityDelivery; readonly pack: ContinuityPack }>;
  readonly previewPack: (threadId: string) => Promise<ContinuityPack>;
}

export interface ContinuityPackPreviewToolDeps {
  readonly previewPack: (threadId: string) => Promise<ContinuityPack>;
  readonly previewResume: (
    threadId: string
  ) => Promise<{
    readonly pack?: ContinuityPack;
    readonly resume: ContinuityResumeRuntimeResultV1;
  }>;
}

function parseInput(
  args: JsonObject,
  open: false
): { readonly threadId: string; readonly capsule?: ContinuityResumeRuntimeCapsuleRequestV1 };
function parseInput(
  args: JsonObject,
  open: true
): { readonly previewDigest: string; readonly threadId: string };
function parseInput(
  args: JsonObject,
  open: boolean
): {
  readonly capsule?: ContinuityResumeRuntimeCapsuleRequestV1;
  readonly previewDigest?: string;
  readonly threadId: string;
} {
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("continuity Pack input must be a plain object");
  }
  const required = open
    ? ["previewDigest", "threadId"] as const
    : ["threadId"] as const;
  const keys = Reflect.ownKeys(args);
  if (
    (open
      ? keys.length !== required.length
      : keys.length !== 1 && keys.length !== 2)
    || keys.some((key) => typeof key !== "string")
    || required.some((key) => !keys.includes(key))
    || (!open && keys.length === 2 && !keys.includes("capsule"))
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
  if (!open) {
    const capsuleDescriptor = descriptors.capsule;
    if (capsuleDescriptor === undefined) return { threadId };
    if (!("value" in capsuleDescriptor)) {
      throw new Error("continuity Capsule must be a plain data property");
    }
    const capsule = validateContinuityResumeRuntimeCapsuleRequest(
      capsuleDescriptor.value
    );
    if (capsule === undefined) {
      throw new Error("continuity Capsule request must use strict plain data");
    }
    return { capsule, threadId };
  }
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

function projectResume(
  result: ContinuityResumeRuntimeResultV1
): JsonObject {
  return JSON.parse(JSON.stringify(result)) as JsonObject;
}

function digestMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requireSourceRunId(value: unknown): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 160
    || value.trim() !== value
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(
      "continuity Pack source runId must be 1-160 characters with no surrounding whitespace or control characters"
    );
  }
  return value;
}

async function inspectPack(
  deps: ContinuityPackOpenToolDeps,
  threadId: string
): Promise<{ readonly digest: string; readonly pack: JsonObject }> {
  const pack = projectPack(await deps.previewPack(threadId));
  return { digest: packDigest(pack), pack };
}

async function inspectPackPreview(
  deps: ContinuityPackPreviewToolDeps,
  threadId: string,
  capsuleRequest?: ContinuityResumeRuntimeCapsuleRequestV1
): Promise<{
  readonly digest: string;
  readonly pack: JsonObject;
  readonly resume: ContinuityResumeRuntimeResultV1;
  readonly capsule?: JsonObject;
}> {
  const enriched = await deps.previewResume(threadId);
  const pack = projectPack(
    enriched.pack ?? await deps.previewPack(threadId)
  );
  const capsule = capsuleRequest === undefined
    ? undefined
    : presentContinuityResumeRuntimeCapsule(enriched.resume, capsuleRequest)
      ?? { reason: "exact-compared-evidence-unavailable", status: "unavailable" };
  return {
    digest: packDigest(pack),
    pack,
    resume: enriched.resume,
    ...(capsule === undefined
      ? {}
      : { capsule: JSON.parse(JSON.stringify(capsule)) as JsonObject })
  };
}

function inputSchema(open: boolean): JsonObject {
  return {
    additionalProperties: false,
    properties: {
      ...(!open ? { capsule: {
        additionalProperties: false,
        description:
          "Optional explicit English or Korean Continuity Capsule render-data request; it never grants timing or action authority.",
        properties: {
          locale: {
            description: "Capsule presentation locale.",
            enum: ["en", "ko"],
            type: "string"
          },
          preparedWork: {
            additionalProperties: false,
            description: "Caller-declared work to display in the Capsule.",
            properties: {
              content: {
                description: "Prepared work content for display.",
                type: "string"
              },
              expectedMinutes: {
                description: "Positive estimated minutes for the prepared work.",
                type: "integer",
                minimum: 1
              },
              kind: {
                description:
                  "Drafts are display-only; action previews require a new approval.",
                enum: ["draft", "action-preview"],
                type: "string"
              },
              title: {
                description: "Short prepared work title.",
                type: "string"
              }
            },
            required: ["kind", "title", "content", "expectedMinutes"],
            type: "object"
          },
          supportingEvidenceRefs: {
            description:
              "Optional exact current-evidence references already linked to the thread.",
            items: {
              additionalProperties: false,
              properties: {
                artifactId: {
                  description: "Exact artifact identifier.",
                  type: "string"
                },
                artifactType: {
                  description: "Canonical Muse artifact type.",
                  type: "string"
                },
                providerId: {
                  description: "Canonical coherent artifact provider identifier.",
                  type: "string"
                },
                role: {
                  description: "Artifact role in the thread.",
                  type: "string"
                }
              },
              required: ["artifactId", "artifactType", "providerId", "role"],
              type: "object"
            },
            type: "array"
          }
        },
        required: ["locale", "preparedWork"],
        type: "object"
      } } : {}),
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
  deps: ContinuityPackPreviewToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Preview a bounded Personal Continuity Pack for one exact thread. Read-only: it resolves current exact linked evidence and may seed or advance a bounded process-local resume baseline, but never opens the Pack, creates a delivery receipt, changes a source or policy, records an outcome, persists the baseline, or grants later authority.",
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
      const { capsule, threadId } = parseInput(args, false);
      const preview = await inspectPackPreview(deps, threadId, capsule);
      return {
        mutation: false,
        pack: preview.pack,
        previewDigest: preview.digest,
        resume: projectResume(preview.resume),
        ...(preview.capsule === undefined ? {} : { capsule: preview.capsule })
      };
    }
  };
}

export function createContinuityPackOpenTool(
  deps: ContinuityPackOpenToolDeps
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
    execute: async (args, context): Promise<JsonObject> => {
      const sourceRunId = requireSourceRunId(context.runId);
      const input = parseInput(args, true);
      const current = await inspectPack(deps, input.threadId);
      if (!digestMatches(input.previewDigest, current.digest)) {
        throw new Error("continuity Pack previewDigest is stale or does not match this exact Pack");
      }
      const opened = await deps.openPack(input.threadId, sourceRunId);
      if (
        opened.delivery.threadId !== input.threadId
        || opened.pack.thread.id !== input.threadId
        || opened.delivery.runId !== sourceRunId
      ) {
        throw new Error("opened Continuity Pack did not preserve the approved thread and source run");
      }
      return {
        delivery: {
          evidenceCount: opened.delivery.evidenceRefs.length,
          id: opened.delivery.id,
          openedAt: opened.delivery.openedAt,
          runId: opened.delivery.runId,
          threadId: opened.delivery.threadId
        },
        success: true
      };
    }
  };
}
