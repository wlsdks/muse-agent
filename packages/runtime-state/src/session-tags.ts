import type { MuseDatabase, SessionTagTable } from "@muse/db";
import { createRunId } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

export interface SessionTag {
  readonly id: string;
  readonly sessionId: string;
  readonly label: string;
  readonly comment?: string;
  readonly createdBy: string;
  readonly createdAt: number;
}

export interface CreateSessionTagInput {
  readonly id?: string;
  readonly sessionId: string;
  readonly label: string;
  readonly comment?: string | null;
  readonly createdBy: string;
  readonly createdAt?: number;
}

export interface SessionTagStore {
  create(input: CreateSessionTagInput): Promise<SessionTag>;
  listBySession(sessionId: string): Promise<readonly SessionTag[]>;
  delete(sessionId: string, tagId: string): Promise<boolean>;
  deleteBySession(sessionId: string): Promise<number>;
}

export interface SessionTagStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => number;
}

type SessionTagRow = Selectable<SessionTagTable>;
type SessionTagInsert = Insertable<SessionTagTable>;

export class InMemorySessionTagStore implements SessionTagStore {
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly tagsBySession = new Map<string, SessionTag[]>();

  constructor(options: SessionTagStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => createRunId("session_tag"));
    this.now = options.now ?? Date.now;
  }

  async create(input: CreateSessionTagInput): Promise<SessionTag> {
    const tag = createSessionTagRecord(input, {
      idFactory: this.idFactory,
      now: this.now
    });
    const tags = this.tagsBySession.get(tag.sessionId) ?? [];

    this.tagsBySession.set(tag.sessionId, [...tags, tag].sort(compareSessionTags));
    return tag;
  }

  async listBySession(sessionId: string): Promise<readonly SessionTag[]> {
    return [...(this.tagsBySession.get(sessionId) ?? [])].sort(compareSessionTags);
  }

  async delete(sessionId: string, tagId: string): Promise<boolean> {
    const tags = this.tagsBySession.get(sessionId) ?? [];
    const remaining = tags.filter((tag) => tag.id !== tagId);

    this.tagsBySession.set(sessionId, remaining);
    return remaining.length !== tags.length;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const count = this.tagsBySession.get(sessionId)?.length ?? 0;
    this.tagsBySession.delete(sessionId);
    return count;
  }
}

export class KyselySessionTagStore implements SessionTagStore {
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: SessionTagStoreOptions = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("session_tag"));
    this.now = options.now ?? Date.now;
  }

  async create(input: CreateSessionTagInput): Promise<SessionTag> {
    const row = await this.db
      .insertInto("session_tags")
      .values(createSessionTagInsert(input, {
        idFactory: this.idFactory,
        now: this.now
      }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapSessionTagRow(row);
  }

  async listBySession(sessionId: string): Promise<readonly SessionTag[]> {
    const rows = await this.db
      .selectFrom("session_tags")
      .selectAll()
      .where("session_id", "=", sessionId)
      .orderBy("created_at", "asc")
      .execute();

    return rows.map(mapSessionTagRow);
  }

  async delete(sessionId: string, tagId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("session_tags")
      .where("session_id", "=", sessionId)
      .where("id", "=", tagId)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const result = await this.db.deleteFrom("session_tags").where("session_id", "=", sessionId).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }
}

export function createSessionTagRecord(
  input: CreateSessionTagInput,
  options: Required<SessionTagStoreOptions>
): SessionTag {
  const comment = input.comment?.trim();

  return {
    ...(comment ? { comment } : {}),
    createdAt: resolveCreatedAt(input.createdAt, options.now),
    createdBy: requireNonBlankString(input.createdBy, "createdBy"),
    id: requireNonBlankString(input.id ?? options.idFactory(), "id"),
    label: requireNonBlankString(input.label, "label"),
    sessionId: requireNonBlankString(input.sessionId, "sessionId")
  };
}

function requireNonBlankString(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`Session tag ${name} must not be blank`);
  }

  return normalized;
}

function resolveCreatedAt(value: number | undefined, now: () => number): number {
  const timestamp = value ?? now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("Session tag createdAt must be a non-negative safe integer");
  }

  return timestamp;
}

export function createSessionTagInsert(
  input: CreateSessionTagInput,
  options: Required<SessionTagStoreOptions>
): SessionTagInsert {
  const tag = createSessionTagRecord(input, options);

  return {
    comment: tag.comment ?? null,
    created_at: tag.createdAt,
    created_by: tag.createdBy,
    id: tag.id,
    label: tag.label,
    session_id: tag.sessionId
  };
}

export function mapSessionTagRow(row: SessionTagRow): SessionTag {
  return {
    ...(row.comment ? { comment: row.comment } : {}),
    createdAt: Number(row.created_at),
    createdBy: row.created_by,
    id: row.id,
    label: row.label,
    sessionId: row.session_id
  };
}

function compareSessionTags(left: SessionTag, right: SessionTag): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}
