const MAX_PROJECTION_BYTES = 1_048_576;

const CREATE_JOURNAL = `CREATE TABLE attunegraph_projection_journal (
  source_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  commit_id TEXT NOT NULL,
  projection_json TEXT NOT NULL CHECK (length(projection_json) BETWEEN 1 AND ${MAX_PROJECTION_BYTES}),
  projection_fingerprint TEXT NOT NULL,
  PRIMARY KEY (source_id, thread_id, generation, commit_id)
) STRICT, WITHOUT ROWID`;
const CREATE_GENERATION_INDEX = `CREATE UNIQUE INDEX attunegraph_projection_journal_generation
ON attunegraph_projection_journal (source_id, thread_id, generation)`;
const CREATE_HEAD = `CREATE TABLE attunegraph_projection_head (
  source_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  commit_id TEXT NOT NULL,
  PRIMARY KEY (source_id, thread_id),
  FOREIGN KEY (source_id, thread_id, generation, commit_id)
    REFERENCES attunegraph_projection_journal (source_id, thread_id, generation, commit_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`;

/** @param {string} value */
function normalizeSql(value) {
  return value.replace(/\s+/g, " ").trim();
}

const objects = Object.freeze([
  Object.freeze({
    type: "index",
    name: "attunegraph_projection_journal_generation",
    tableName: "attunegraph_projection_journal",
    normalizedSql: normalizeSql(CREATE_GENERATION_INDEX)
  }),
  Object.freeze({
    type: "table",
    name: "attunegraph_projection_head",
    tableName: "attunegraph_projection_head",
    normalizedSql: normalizeSql(CREATE_HEAD)
  }),
  Object.freeze({
    type: "table",
    name: "attunegraph_projection_journal",
    tableName: "attunegraph_projection_journal",
    normalizedSql: normalizeSql(CREATE_JOURNAL)
  })
]);

const headForeignKey = Object.freeze([
  Object.freeze({
    id: 0,
    seq: 0,
    table: "attunegraph_projection_journal",
    from: "source_id",
    to: "source_id",
    onUpdate: "RESTRICT",
    onDelete: "RESTRICT",
    match: "NONE"
  }),
  Object.freeze({
    id: 0,
    seq: 1,
    table: "attunegraph_projection_journal",
    from: "thread_id",
    to: "thread_id",
    onUpdate: "RESTRICT",
    onDelete: "RESTRICT",
    match: "NONE"
  }),
  Object.freeze({
    id: 0,
    seq: 2,
    table: "attunegraph_projection_journal",
    from: "generation",
    to: "generation",
    onUpdate: "RESTRICT",
    onDelete: "RESTRICT",
    match: "NONE"
  }),
  Object.freeze({
    id: 0,
    seq: 3,
    table: "attunegraph_projection_journal",
    from: "commit_id",
    to: "commit_id",
    onUpdate: "RESTRICT",
    onDelete: "RESTRICT",
    match: "NONE"
  })
]);

export const ATTUNEGRAPH_PHYSICAL_SCHEMA_V1 = Object.freeze({
  applicationId: 0x41544731,
  userVersion: 1,
  maxProjectionBytes: MAX_PROJECTION_BYTES,
  createJournal: CREATE_JOURNAL,
  createGenerationIndex: CREATE_GENERATION_INDEX,
  createHead: CREATE_HEAD,
  objects,
  headForeignKey
});

const MATCH = Object.freeze({ kind: "match" });
const FUTURE = Object.freeze({ kind: "future" });
const FOREIGN_OR_CORRUPT = Object.freeze({ kind: "foreign-or-corrupt" });

/**
 * @param {{
 *   readonly applicationId: number;
 *   readonly userVersion: number;
 *   readonly objects: readonly Readonly<Record<string, unknown>>[];
 *   readonly headForeignKey: readonly Readonly<Record<string, unknown>>[];
 * }} admittedProfile
 */
export function classifyAttuneGraphPhysicalSchemaV1(admittedProfile) {
  if (
    admittedProfile.applicationId === ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.applicationId
    && Number.isInteger(admittedProfile.userVersion)
    && admittedProfile.userVersion > ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.userVersion
  ) return FUTURE;
  if (
    admittedProfile.applicationId !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.applicationId
    || admittedProfile.userVersion !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.userVersion
    || admittedProfile.objects.length !== objects.length
    || admittedProfile.headForeignKey.length !== headForeignKey.length
  ) return FOREIGN_OR_CORRUPT;
  for (let index = 0; index < objects.length; index += 1) {
    const actual = admittedProfile.objects[index];
    const expected = objects[index];
    if (actual === undefined || expected === undefined) return FOREIGN_OR_CORRUPT;
    if (
      actual.type !== expected.type
      || actual.name !== expected.name
      || actual.tableName !== expected.tableName
      || actual.normalizedSql !== expected.normalizedSql
    ) return FOREIGN_OR_CORRUPT;
  }
  for (let index = 0; index < headForeignKey.length; index += 1) {
    const actual = admittedProfile.headForeignKey[index];
    const expected = headForeignKey[index];
    if (actual === undefined || expected === undefined) return FOREIGN_OR_CORRUPT;
    if (
      actual.id !== expected.id
      || actual.seq !== expected.seq
      || actual.table !== expected.table
      || actual.from !== expected.from
      || actual.to !== expected.to
      || actual.onUpdate !== expected.onUpdate
      || actual.onDelete !== expected.onDelete
      || actual.match !== expected.match
    ) return FOREIGN_OR_CORRUPT;
  }
  return MATCH;
}
