import { createHash } from "node:crypto";

const TOP_LEVEL_KEYS = [
  "dueText",
  "intentClass",
  "nextAction",
  "proposedTitle",
  "source"
] as const;
const SOURCE_KEYS = ["conversationId", "text", "turnId"] as const;
const MAX_ID_LENGTH = 128;
const MAX_SOURCE_TEXT_LENGTH = 10_000;
const MAX_TASK_FIELD_LENGTH = 500;
const TASK_INTENT_CLASSES: readonly TaskIntentClass[] = [
  "assumption",
  "owner-commitment",
  "question",
  "third-party"
];

export type TaskIntentClass =
  | "assumption"
  | "owner-commitment"
  | "question"
  | "third-party";

export interface TaskIntentObservation {
  readonly dueText?: string;
  readonly intentClass: TaskIntentClass;
  readonly nextAction?: string;
  readonly proposedTitle?: string;
  readonly source: {
    readonly conversationId: string;
    readonly text: string;
    readonly turnId: string;
  };
}

export interface RejectedTaskIntentDraft {
  readonly authority: {
    readonly deadlineInference: "none";
    readonly taskWrite: "none";
  };
  readonly createAction: "none";
  readonly reason:
    | "assumption"
    | "invalid-input"
    | "question"
    | "third-party";
  readonly status: "rejected";
}

export interface TaskIntentDraft {
  readonly authority: {
    readonly deadlineInference: "none";
    readonly decomposition: "none";
    readonly taskWrite: "none";
  };
  readonly createAction: {
    readonly action: "create-task";
    readonly draftId: string;
    readonly requiredAuthority: "explicit-owner-confirmation";
    readonly status: "blocked";
  };
  readonly draftId: string;
  readonly due: {
    readonly state: "missing" | "user-stated";
    readonly text?: string;
  };
  readonly missing: readonly {
    readonly field: "due" | "nextAction";
    readonly question: string;
  }[];
  readonly nextAction: {
    readonly state: "missing" | "user-stated";
    readonly text?: string;
  };
  readonly proposedList: "personal-tasks";
  readonly source: {
    readonly conversationId: string;
    readonly textDigest: string;
    readonly turnId: string;
  };
  readonly status: "needs-clarification" | "ready-for-confirmation";
  readonly title: string;
}

export type TaskIntentDraftProjection = RejectedTaskIntentDraft | TaskIntentDraft;

/**
 * Project one observed task intent into an inert, owner-reviewable draft.
 *
 * The function cannot write a task: it accepts no provider, store, tool, or
 * callback. A downstream create path must bind explicit owner confirmation to
 * the returned content-bound draft ID.
 */
export function projectTaskIntentDraft(
  value: TaskIntentObservation
): TaskIntentDraftProjection {
  if (!isTaskIntentObservation(value)) {
    return rejectedTaskIntent("invalid-input");
  }
  if (value.intentClass !== "owner-commitment") {
    return rejectedTaskIntent(value.intentClass);
  }

  const sourceText = value.source.text.trim();
  const proposedTitle = value.proposedTitle === undefined
    ? sourceText
    : value.proposedTitle.trim();
  const nextAction = value.nextAction?.trim();
  const dueText = value.dueText?.trim();
  if (
    !isTaskField(proposedTitle)
    || !isGroundedInSource(proposedTitle, sourceText)
    || (nextAction !== undefined
      && (!isTaskField(nextAction) || !isGroundedInSource(nextAction, sourceText)))
    || (dueText !== undefined
      && (!isTaskField(dueText) || !isGroundedInSource(dueText, sourceText)))
  ) {
    return rejectedTaskIntent("invalid-input");
  }

  const source = Object.freeze({
    conversationId: value.source.conversationId,
    textDigest: digest([
      "muse.task-intent-source/v1",
      value.source.conversationId,
      value.source.turnId,
      value.source.text
    ]),
    turnId: value.source.turnId
  });
  const draftId = `taskdraft_v1_${digest([
    "muse.task-intent-draft/v1",
    source.textDigest,
    proposedTitle,
    nextAction ?? null,
    dueText ?? null
  ]).slice(0, 32)}`;
  const missingItems: Array<{
    readonly field: "due" | "nextAction";
    readonly question: string;
  }> = [];
  if (nextAction === undefined) {
    missingItems.push(Object.freeze({
      field: "nextAction",
      question: "What is the next concrete action?"
    }));
  }
  if (dueText === undefined) {
    missingItems.push(Object.freeze({
      field: "due",
      question: "When, if at all, should this be due?"
    }));
  }
  const missing = Object.freeze(missingItems);

  return Object.freeze({
    authority: Object.freeze({
      deadlineInference: "none",
      decomposition: "none",
      taskWrite: "none"
    }),
    createAction: Object.freeze({
      action: "create-task",
      draftId,
      requiredAuthority: "explicit-owner-confirmation",
      status: "blocked"
    }),
    draftId,
    due: dueText === undefined
      ? Object.freeze({ state: "missing" as const })
      : Object.freeze({ state: "user-stated" as const, text: dueText }),
    missing,
    nextAction: nextAction === undefined
      ? Object.freeze({ state: "missing" as const })
      : Object.freeze({ state: "user-stated" as const, text: nextAction }),
    proposedList: "personal-tasks",
    source,
    status: missing.length > 0 ? "needs-clarification" : "ready-for-confirmation",
    title: proposedTitle
  });
}

function rejectedTaskIntent(
  reason: RejectedTaskIntentDraft["reason"]
): RejectedTaskIntentDraft {
  return Object.freeze({
    authority: Object.freeze({
      deadlineInference: "none",
      taskWrite: "none"
    }),
    createAction: "none",
    reason,
    status: "rejected"
  });
}

function isTaskIntentObservation(value: unknown): value is TaskIntentObservation {
  if (!hasOnlyKeys(value, TOP_LEVEL_KEYS)
    || !hasOnlyKeys(value.source, SOURCE_KEYS)
    || !hasRequiredOwnKeys(value, ["intentClass", "source"])
    || !hasRequiredOwnKeys(value.source, SOURCE_KEYS)
    || !isBoundedId(value.source.conversationId)
    || !isBoundedId(value.source.turnId)
    || typeof value.source.text !== "string"
    || value.source.text.trim().length === 0
    || value.source.text.length > MAX_SOURCE_TEXT_LENGTH
    || typeof value.intentClass !== "string"
    || !TASK_INTENT_CLASSES.includes(value.intentClass as TaskIntentClass)
  ) return false;
  return ["dueText", "nextAction", "proposedTitle"].every((key) => {
    const field = value[key as keyof TaskIntentObservation];
    return field === undefined || typeof field === "string";
  });
}

function hasOnlyKeys<T extends readonly string[]>(
  value: unknown,
  allowed: T
): value is Record<T[number], unknown> {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && Reflect.ownKeys(value).every((key) =>
      typeof key === "string" && allowed.includes(key)
    );
}

function hasRequiredOwnKeys(
  value: object,
  required: readonly string[]
): boolean {
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function isTaskField(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_TASK_FIELD_LENGTH
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isGroundedInSource(value: string, sourceText: string): boolean {
  return sourceText.normalize("NFC").toLowerCase()
    .includes(value.normalize("NFC").toLowerCase());
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
