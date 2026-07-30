import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  copyFile,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TextDecoder, TextEncoder, types as nodeTypes } from "node:util";

const FORMAT = "attunegraph-portable";
const FORMAT_VERSION = 1;
const CANONICALIZATION = "attunegraph-canonical-json-utf16@1";
const LIMITS_PROFILE = "attunegraph-portable-limits@1";
const STATE_MODEL = "projection-journal-head@1";
const HASH_ALGORITHM = "sha-256";
const RECORD_DOMAIN = "attunegraph.portable-record.v1";
const STATE_DOMAIN = "attunegraph.portable-state.v1";
const STORE_DOMAIN = "attunegraph.store-projection.v1";
const RECORD_PREFIX = "attunegraph-portable-record:";
const STATE_PREFIX = "attunegraph-state:";
const STORE_PREFIX = "attunegraph-store:";

const LIMITS = Object.freeze({
  projections: 1_000_000,
  heads: 1_000_000,
  scopes: 1_000_000,
  totalRecords: 2_000_002,
  unsignedStoredProjectionBytes: 1_048_256,
  storedProjectionEnvelopeBytes: 1_048_576,
  portableLineBytes: 1_114_112,
  edgeLineBytes: 16_384,
  artifactBytes: 1_099_511_627_776,
  jsonDepth: 12,
  descriptorsPerProjection: 32_768,
  stringCodeUnits: 16_384,
  stringBytes: 16_384,
  aggregateProjectionStringBytes: 1_000_000,
  recommendedTransportChunkBytes: 262_144
});

const CASES = Object.freeze([
  "empty",
  "one-scope-two-generations",
  "unicode-multi-scope"
]);
const KNOWN_BYTES = Object.freeze({
  empty: 828,
  "one-scope-two-generations": 5_262
});
const MANIFEST_FILE = "manifest.json";
const README_FILE = "README.md";
const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const checkedInRoot = resolve(packageRoot, "fixtures/portable-v1");
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
  throw new Error(message);
}

function hash(domain, bytes) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(Uint8Array.of(0))
    .update(bytes)
    .digest("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertValidString(value, label, state) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (value.length > LIMITS.stringCodeUnits) {
    fail(`${label} exceeds the UTF-16 string limit`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`${label} contains an unpaired high surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`${label} contains an unpaired low surrogate`);
    }
  }
  const bytes = encoder.encode(value).byteLength;
  if (bytes > LIMITS.stringBytes) fail(`${label} exceeds the UTF-8 string limit`);
  if (state !== undefined) {
    state.aggregateStringBytes += bytes;
    if (state.aggregateStringBytes > LIMITS.aggregateProjectionStringBytes) {
      fail(`${label} exceeds the aggregate projection string limit`);
    }
  }
}

function ownDataEntries(value, label) {
  if (
    value === null
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${label} must be a non-proxy plain record`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail(`${label} must not contain symbol keys`);
  }
  return keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      fail(`${label}.${key} must be a data property`);
    }
    return [key, descriptor.value];
  });
}

function canonicalJson(value, options = {}) {
  const state = {
    descriptors: 0,
    aggregateStringBytes: 0,
    projection: options.projection === true
  };
  const visit = (current, depth, label) => {
    if (depth > LIMITS.jsonDepth) fail(`${label} exceeds the JSON depth limit`);
    if (current === null || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (
        !Number.isSafeInteger(current)
        || current < 0
        || Object.is(current, -0)
      ) {
        fail(`${label} must be a non-negative safe integer`);
      }
      return JSON.stringify(current);
    }
    if (typeof current === "string") {
      assertValidString(current, label, state.projection ? state : undefined);
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      if (nodeTypes.isProxy(current)) fail(`${label} must not be a proxy`);
      const keys = Reflect.ownKeys(current);
      const expectedKeys = [
        ...Array.from({ length: current.length }, (_, index) => String(index)),
        "length"
      ];
      if (
        keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index])
      ) {
        fail(`${label} must be a dense array without extra fields`);
      }
      state.descriptors += current.length;
      return `[${current.map((_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          fail(`${label}[${index}] must be a data property`);
        }
        return visit(descriptor.value, depth + 1, `${label}[${index}]`);
      }).join(",")}]`;
    }
    if (current === undefined || typeof current === "bigint") {
      fail(`${label} is not a canonical JSON value`);
    }
    const entries = ownDataEntries(current, label);
    state.descriptors += entries.length;
    if (
      state.projection
      && state.descriptors > LIMITS.descriptorsPerProjection
    ) {
      fail(`${label} exceeds the projection descriptor limit`);
    }
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => {
      assertValidString(key, `${label} key`, state.projection ? state : undefined);
      return `${JSON.stringify(key)}:${visit(item, depth + 1, `${label}.${key}`)}`;
    }).join(",")}}`;
  };
  return visit(value, 1, "$");
}

function assertExactKeys(value, expected, label) {
  const actual = ownDataEntries(value, label).map(([key]) => key).sort();
  assert.deepEqual(actual, [...expected].sort(), `${label} fields`);
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
}

function assertStoredProjection(projection, label) {
  assertExactKeys(projection, [
    "schemaVersion",
    "snapshot",
    "observationId",
    "canonicalProjection",
    "projectionFingerprint",
    "observedAt",
    "sourceFreshness",
    "assertions"
  ], label);
  assert.equal(projection.schemaVersion, 1, `${label}.schemaVersion`);
  assertExactKeys(projection.snapshot, [
    "schemaVersion",
    "scope",
    "generation",
    "commitId"
  ], `${label}.snapshot`);
  assert.equal(projection.snapshot.schemaVersion, 1);
  assertExactKeys(
    projection.snapshot.scope,
    ["sourceId", "threadId"],
    `${label}.snapshot.scope`
  );
  assertValidString(projection.snapshot.scope.sourceId, `${label}.sourceId`);
  assertValidString(projection.snapshot.scope.threadId, `${label}.threadId`);
  assertPositiveSafeInteger(projection.snapshot.generation, `${label}.generation`);
  for (const field of [
    "commitId",
    "observationId",
    "canonicalProjection",
    "projectionFingerprint",
    "observedAt"
  ]) {
    assertValidString(projection[field] ?? projection.snapshot[field], `${label}.${field}`);
  }
  assertExactKeys(
    projection.sourceFreshness,
    ["state", "observedAt"],
    `${label}.sourceFreshness`
  );
  if (!["fresh", "stale", "unknown"].includes(projection.sourceFreshness.state)) {
    fail(`${label}.sourceFreshness.state is invalid`);
  }
  assertValidString(
    projection.sourceFreshness.observedAt,
    `${label}.sourceFreshness.observedAt`
  );
  if (!Array.isArray(projection.assertions)) {
    fail(`${label}.assertions must be an array`);
  }
  canonicalJson(projection, { projection: true });
}

function mintEnvelope(unsigned, domain, prefix, idField, limits) {
  const unsignedJson = canonicalJson(unsigned, {
    projection: idField === "storeEnvelopeId"
  });
  const unsignedBytes = encoder.encode(unsignedJson);
  if (unsignedBytes.byteLength > limits.unsigned) {
    fail(`${idField} unsigned body exceeds its byte limit`);
  }
  const contentId = `${prefix}${hash(domain, unsignedBytes)}`;
  const envelope = { ...unsigned, [idField]: contentId };
  const envelopeJson = canonicalJson(envelope, {
    projection: idField === "storeEnvelopeId"
  });
  const envelopeBytes = encoder.encode(envelopeJson);
  if (envelopeBytes.byteLength > limits.envelope) {
    fail(`${idField} envelope exceeds its byte limit`);
  }
  return {
    contentId,
    envelope,
    unsignedBytes: unsignedBytes.byteLength,
    envelopeBytes: envelopeBytes.byteLength,
    envelopeJson
  };
}

function compareBytes(left, right) {
  return Buffer.compare(
    Buffer.from(encoder.encode(left)),
    Buffer.from(encoder.encode(right))
  );
}

function compareScopes(left, right) {
  return compareBytes(left.sourceId, right.sourceId)
    || compareBytes(left.threadId, right.threadId);
}

function scopeKey(scope) {
  return `${Buffer.from(encoder.encode(scope.sourceId)).toString("hex")}:${
    Buffer.from(encoder.encode(scope.threadId)).toString("hex")
  }`;
}

function recordLine(unsigned, edge) {
  const maximum = edge ? LIMITS.edgeLineBytes : LIMITS.portableLineBytes;
  const minted = mintEnvelope(
    unsigned,
    RECORD_DOMAIN,
    RECORD_PREFIX,
    "recordId",
    { unsigned: maximum, envelope: maximum }
  );
  const bytes = encoder.encode(`${minted.envelopeJson}\n`);
  return {
    bytes,
    record: minted.envelope,
    ledger: {
      kind: minted.envelope.kind,
      sequence: minted.envelope.sequence,
      unsignedBodyBytes: minted.unsignedBytes,
      envelopeBytes: minted.envelopeBytes,
      lineBytes: bytes.byteLength,
      recordId: minted.contentId
    }
  };
}

function deriveCase(input, inputFile) {
  assertExactKeys(input, ["schemaVersion", "case", "projections"], inputFile);
  assert.equal(input.schemaVersion, 1, `${inputFile}.schemaVersion`);
  if (!CASES.includes(input.case)) fail(`${inputFile}.case is unknown`);
  if (!Array.isArray(input.projections)) fail(`${inputFile}.projections must be an array`);
  if (input.projections.length > LIMITS.projections) {
    fail(`${inputFile} exceeds the projection-count limit`);
  }
  input.projections.forEach((projection, index) => {
    assertStoredProjection(projection, `${inputFile}.projections[${index}]`);
  });

  const projections = [...input.projections].sort((left, right) => {
    const scopeOrder = compareScopes(left.snapshot.scope, right.snapshot.scope);
    return scopeOrder || left.snapshot.generation - right.snapshot.generation;
  });
  const identities = [];
  let previous;
  for (const projection of projections) {
    const scope = projection.snapshot.scope;
    if (previous === undefined || compareScopes(previous.scope, scope) !== 0) {
      assert.equal(projection.snapshot.generation, 1, "each scope must begin at generation 1");
    } else {
      assert.equal(
        projection.snapshot.generation,
        previous.generation + 1,
        "projection generations must be contiguous"
      );
    }
    const minted = mintEnvelope(
      projection,
      STORE_DOMAIN,
      STORE_PREFIX,
      "storeEnvelopeId",
      {
        unsigned: LIMITS.unsignedStoredProjectionBytes,
        envelope: LIMITS.storedProjectionEnvelopeBytes
      }
    );
    identities.push({
      scope,
      generation: projection.snapshot.generation,
      commitId: projection.snapshot.commitId,
      projectionId: minted.contentId,
      projection
    });
    previous = {
      scope,
      generation: projection.snapshot.generation
    };
  }

  const headsByScope = new Map();
  for (const identity of identities) headsByScope.set(scopeKey(identity.scope), identity);
  const heads = [...headsByScope.values()].sort((left, right) =>
    compareScopes(left.scope, right.scope)
  );
  if (heads.length > LIMITS.heads || heads.length > LIMITS.scopes) {
    fail(`${inputFile} exceeds a head/scope count limit`);
  }

  const chunks = [];
  const ledgers = [];
  let sequence = 0;
  const append = (unsigned, edge) => {
    const prepared = recordLine(unsigned, edge);
    chunks.push(prepared.bytes);
    ledgers.push(prepared.ledger);
    sequence += 1;
    return prepared;
  };
  const manifest = append({
    canonicalization: CANONICALIZATION,
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    hashAlgorithm: HASH_ALGORITHM,
    kind: "manifest",
    limitsProfile: LIMITS_PROFILE,
    schemaVersion: 1,
    sequence,
    stateModel: STATE_MODEL
  }, true);
  for (const identity of identities) {
    append({
      kind: "projection",
      projection: identity.projection,
      projectionId: identity.projectionId,
      schemaVersion: 1,
      sequence
    }, false);
  }
  for (const identity of heads) {
    append({
      commitId: identity.commitId,
      generation: identity.generation,
      kind: "head",
      projectionId: identity.projectionId,
      schemaVersion: 1,
      scope: identity.scope,
      sequence
    }, false);
  }
  const priorBytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const priorRecordCount = chunks.length;
  const stateId = `${STATE_PREFIX}${hash(STATE_DOMAIN, priorBytes)}`;
  const footer = append({
    headCount: heads.length,
    kind: "footer",
    manifestId: manifest.record.recordId,
    priorByteLength: priorBytes.byteLength,
    priorRecordCount,
    projectionCount: identities.length,
    schemaVersion: 1,
    scopeCount: heads.length,
    sequence,
    stateId
  }, true);
  const artifact = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (artifact.byteLength > LIMITS.artifactBytes) fail("artifact exceeds its byte limit");
  if (chunks.length > LIMITS.totalRecords) fail("record count exceeds its limit");
  if (Object.hasOwn(KNOWN_BYTES, input.case)) {
    assert.equal(
      artifact.byteLength,
      KNOWN_BYTES[input.case],
      `${input.case} exact byte pin`
    );
  }
  return {
    artifact,
    manifestCase: {
      case: input.case,
      file: `${input.case}.atgx`,
      input: inputFile,
      artifactBytes: artifact.byteLength,
      artifactSha256: sha256(artifact),
      stateId,
      exportId: footer.record.recordId,
      scopeCount: heads.length,
      projectionCount: identities.length,
      headCount: heads.length,
      recordCount: chunks.length,
      lines: ledgers
    }
  };
}

function assertArtifactFraming(bytes, label) {
  if (bytes.byteLength === 0) fail(`${label} is empty`);
  if (
    bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf
  ) {
    fail(`${label} has a BOM`);
  }
  if (bytes.includes(0x0d)) fail(`${label} contains CR`);
  if (bytes.at(-1) !== 0x0a) fail(`${label} is missing the final LF`);
  const text = decoder.decode(bytes);
  const rawLines = text.slice(0, -1).split("\n");
  if (rawLines.some((line) => line.length === 0)) fail(`${label} has a blank line`);
  return rawLines;
}

function inspectArtifact(bytes, label) {
  const rawLines = assertArtifactFraming(bytes, label);
  const lines = rawLines.map((rawLine, index) => {
    let record;
    try {
      record = JSON.parse(rawLine);
    } catch (cause) {
      throw new Error(`${label} line ${index} is invalid JSON`, { cause });
    }
    assert.equal(rawLine, canonicalJson(record), `${label} line ${index} canonical JSON`);
    const recordId = record.recordId;
    const { recordId: ignoredRecordId, ...unsigned } = record;
    void ignoredRecordId;
    const edge = index === 0 || index === rawLines.length - 1;
    const reminted = recordLine(unsigned, edge);
    assert.equal(recordId, reminted.record.recordId, `${label} line ${index} record ID`);
    assert.equal(record.sequence, index, `${label} line ${index} sequence`);
    return reminted.ledger;
  });
  assert.equal(lines[0]?.kind, "manifest", `${label} first record`);
  assert.equal(lines.at(-1)?.kind, "footer", `${label} final record`);
  assert.equal(
    lines.slice(1, -1).some((line) => line.kind === "footer"),
    false,
    `${label} has trailing records after its footer`
  );
  return lines;
}

async function readJson(path, label) {
  const bytes = await readFile(path);
  if (bytes.includes(0x0d)) fail(`${label} contains CR`);
  if (bytes.at(-1) !== 0x0a) fail(`${label} is missing its final LF`);
  if (
    bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf
  ) {
    fail(`${label} has a BOM`);
  }
  const text = decoder.decode(bytes);
  try {
    return { bytes, value: JSON.parse(text) };
  } catch (cause) {
    throw new Error(`${label} is invalid JSON`, { cause });
  }
}

async function deriveCorpus(root) {
  const cases = [];
  const inputs = new Map();
  for (const caseName of CASES) {
    const inputFile = `${caseName}.input.json`;
    const source = await readJson(join(root, inputFile), inputFile);
    const derived = deriveCase(source.value, inputFile);
    assert.equal(source.value.case, caseName, `${inputFile} case/file binding`);
    inputs.set(inputFile, source.bytes);
    cases.push(derived);
  }
  return {
    inputs,
    cases,
    manifest: {
      schemaVersion: 1,
      corpus: "attunegraph-portable-fixtures",
      corpusVersion: 1,
      cases: cases.map(({ manifestCase }) => manifestCase)
    }
  };
}

async function assertDirectory(path, label) {
  const details = await stat(path);
  if (!details.isDirectory()) fail(`${label} must be an existing directory`);
  return realpath(path);
}

async function checkCorpus(root) {
  const actualRoot = await assertDirectory(root, "corpus");
  const expectedNames = [
    README_FILE,
    MANIFEST_FILE,
    ...CASES.flatMap((caseName) => [
      `${caseName}.input.json`,
      `${caseName}.atgx`
    ])
  ].sort();
  assert.deepEqual((await readdir(actualRoot)).sort(), expectedNames, "corpus file set");
  const derived = await deriveCorpus(checkedInRoot);
  assert.deepEqual(
    await readFile(join(actualRoot, README_FILE)),
    await readFile(join(checkedInRoot, README_FILE)),
    "README.md exact bytes"
  );
  for (const [inputFile, expected] of derived.inputs) {
    assert.deepEqual(
      await readFile(join(actualRoot, inputFile)),
      expected,
      `${inputFile} exact bytes`
    );
  }
  const actualManifest = await readJson(join(actualRoot, MANIFEST_FILE), MANIFEST_FILE);
  assert.deepEqual(actualManifest.value, derived.manifest, "corpus manifest");
  for (const { artifact, manifestCase } of derived.cases) {
    const actual = await readFile(join(actualRoot, manifestCase.file));
    assertArtifactFraming(actual, manifestCase.file);
    assert.deepEqual(actual, artifact, `${manifestCase.file} exact raw bytes`);
    const actualLedger = inspectArtifact(actual, manifestCase.file);
    assert.deepEqual(actualLedger, manifestCase.lines, `${manifestCase.file} line ledger`);
  }
  process.stdout.write(`verified AttuneGraph portable fixture corpus: ${actualRoot}\n`);
}

async function writeCorpus(outputRoot) {
  const actualOutput = await assertDirectory(outputRoot, "output");
  const actualCheckedIn = await realpath(checkedInRoot);
  const actualRepository = await realpath(repositoryRoot);
  if (
    actualOutput === actualCheckedIn
    || actualOutput === actualRepository
    || actualOutput.startsWith(`${actualRepository}${sep}`)
  ) {
    fail("repository paths are never valid output directories");
  }
  assert.deepEqual(await readdir(actualOutput), [], "output directory must be empty");
  const derived = await deriveCorpus(actualCheckedIn);
  await copyFile(join(actualCheckedIn, README_FILE), join(actualOutput, README_FILE));
  for (const [name, bytes] of derived.inputs) {
    await writeFile(join(actualOutput, name), bytes, { flag: "wx" });
  }
  for (const { artifact, manifestCase } of derived.cases) {
    await writeFile(join(actualOutput, manifestCase.file), artifact, { flag: "wx" });
  }
  await writeFile(
    join(actualOutput, MANIFEST_FILE),
    `${JSON.stringify(derived.manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  );
  await checkCorpus(actualOutput);
}

function parseMode(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--check")) {
    return { kind: "check", directory: checkedInRoot };
  }
  if (
    args.length === 2
    && (args[0] === "--check-dir" || args[0] === "--output-dir")
    && typeof args[1] === "string"
    && args[1].length > 0
  ) {
    return {
      kind: args[0] === "--check-dir" ? "check" : "output",
      directory: resolve(args[1])
    };
  }
  fail(
    "usage: verify-attunegraph-portable-fixtures.mjs "
    + "[--check | --check-dir <existing-dir> | --output-dir <existing-empty-dir>]"
  );
}

try {
  assert.equal(
    LIMITS.recommendedTransportChunkBytes,
    262_144,
    "portable transport recommendation pin"
  );
  const mode = parseMode(process.argv.slice(2));
  if (mode.kind === "check") await checkCorpus(mode.directory);
  else await writeCorpus(mode.directory);
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exitCode = 1;
}
