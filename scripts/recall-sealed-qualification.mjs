import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import {
  constants as FS_CONSTANTS,
  lstatSync,
  realpathSync
} from "node:fs";
import {
  lstat,
  link,
  open,
  readdir,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const CANDIDATE_CATEGORIES = Object.freeze(["ordinary", "absent", "correction"]);
export const CANDIDATE_LOCALES = Object.freeze(["ko", "en"]);
export const CANDIDATE_DOMAINS = Object.freeze(["life", "health", "work", "preference", "reference"]);

const AES_ALGORITHM = "aes-256-gcm";
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;
const ENVELOPE_SCHEMA = "muse-recall-sealed-envelope-v2";
const POOL_SCHEMA = "muse-recall-sealed-pool-v2";
const LEDGER_SCHEMA = "muse-recall-sealed-ledger-v2";
const SEAL_CLAIM_SCHEMA = "muse-recall-seal-claim-v2";
const SELECTION_CLAIM_SCHEMA = "muse-recall-selection-claim-v2";
const REPRODUCTION_CLAIM_SCHEMA = "muse-recall-reproduction-claim-v2";
const LOCK_SCHEMA = "muse-recall-mutation-lock-v2";
const ZERO_HASH = "0".repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const FILE_MODE = 0o600;
const ROOT_MODE = 0o700;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_DEPTH = 128;
const MAX_JSON_STRING_BYTES = 4 * 1024 * 1024;
const MAX_STRING_BYTES = 65_536;
const MAX_PRIOR_PAYLOADS = 1_000;
const MAX_CORPUS_PAYLOADS_PER_CASE = 8;
const MAX_OVERLAP_PAYLOADS = 2_000;
const MAX_OVERLAP_COMPARISONS = 2_000_000;
const MAX_OVERLAP_BYTES = 8 * 1024 * 1024;
const LOCK_ATTEMPTS = 500;
const LOCK_DELAY_MS = 5;

const INPUT_KEYS = Object.freeze(["metadata", "pool", "priorPayloads"]);
const CANDIDATE_KEYS = Object.freeze(["category", "domain", "locale", "scorer", "solver"]);
const SOLVER_KEYS = Object.freeze(["corpus", "query", "runtimeOptions"]);
const CORPUS_KEYS = Object.freeze(["sourceHash", "text"]);
const RUNTIME_KEYS = Object.freeze(["refine", "topK"]);
const SEALED_CANDIDATE_KEYS = Object.freeze([
  "category",
  "domain",
  "locale",
  "opaqueId",
  "scorer",
  "solver"
]);
const SEALED_SOLVER_KEYS = Object.freeze(["corpus", "opaqueId", "query", "runtimeOptions"]);
const ENVELOPE_KEYS = Object.freeze([
  "algorithm",
  "authTagBase64",
  "ciphertextBase64",
  "ciphertextSha256",
  "ivBase64",
  "schema",
  "version"
]);
const TUPLE_KEYS = Object.freeze([
  "claimHash",
  "finalDatasetHash",
  "metadataHash",
  "poolCiphertextHash",
  "poolEnvelopeHash",
  "poolHash",
  "seedCommitment",
  "selectedEnvelopeHash"
]);
const ENTRY_KEYS = Object.freeze([
  ...TUPLE_KEYS,
  "entryHash",
  "previousHash",
  "schema",
  "sequence",
  "status",
  "timestamp"
]);
const STATUSES = new Set([
  "sealed",
  "consuming",
  "passed",
  "reproduction-consuming",
  "reproduced",
  "burned"
]);
const CLOSED_FAILURE_CODES = new Set([
  "SEALED_CLAIM_IO_FAILED",
  "SEALED_CRYPTO_FAILED",
  "SEALED_INPUT_INVALID",
  "SEALED_INTERNAL_FAILURE",
  "SEALED_LEDGER_INVALID",
  "SEALED_LEDGER_IO_FAILED",
  "SEALED_LIFECYCLE_CLOSED",
  "SEALED_LOCK_FAILED",
  "SEALED_MATRIX_INVALID",
  "SEALED_NETWORK_CALLBACK_FAILED",
  "SEALED_OVERLAP_INVALID",
  "SEALED_REPRODUCTION_CLOSED",
  "SEALED_ROOT_INVALID",
  "SEALED_ROOT_IO_FAILED",
  "SEALED_SEAL_IO_FAILED",
  "SEALED_SOLVER_SCHEMA_INVALID"
]);
const FAILURE_BRANDS = new WeakMap();

function failure(code) {
  const closedCode = CLOSED_FAILURE_CODES.has(code) ? code : "SEALED_INTERNAL_FAILURE";
  const error = new Error(closedCode);
  error.stack = closedCode;
  Object.defineProperty(error, "code", {
    configurable: false,
    enumerable: true,
    value: closedCode,
    writable: false
  });
  FAILURE_BRANDS.set(error, closedCode);
  return error;
}

function knownFailure(error) {
  return error !== null &&
    (typeof error === "object" || typeof error === "function")
    ? FAILURE_BRANDS.get(error)
    : undefined;
}

export function sealedFailureCode(error) {
  try {
    return knownFailure(error) ?? "SEALED_INTERNAL_FAILURE";
  } catch {
    return "SEALED_INTERNAL_FAILURE";
  }
}

function closeError(error, fallback) {
  return failure(knownFailure(error) ?? fallback);
}

async function closedAsync(operation, fallback = "SEALED_INTERNAL_FAILURE") {
  try {
    return await operation();
  } catch (error) {
    throw closeError(error, fallback);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataProperties(value, expected, code) {
  if (!isPlainObject(value)) throw failure(code);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw failure(code);
  const actual = [...keys].sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length ||
      actual.some((key, index) => key !== wanted[index])) {
    throw failure(code);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw failure(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function canonicalArrayIndex(key, length) {
  if (!/^(0|[1-9][0-9]*)$/u.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    index.toString() === key
    ? index
    : undefined;
}

function canonicalJson(value, code) {
  const ancestors = new Set();
  let visited = 0;

  function visit(current, depth) {
    visited += 1;
    if (visited > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw failure(code);
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > MAX_JSON_STRING_BYTES) throw failure(code);
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw failure(code);
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== "object" || ancestors.has(current)) throw failure(code);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_JSON_NODES) throw failure(code);
        const keys = Reflect.ownKeys(current);
        const values = new Map();
        for (const key of keys) {
          if (key === "length") continue;
          if (typeof key !== "string") throw failure(code);
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          const index = canonicalArrayIndex(key, current.length);
          if (descriptor === undefined ||
              index === undefined ||
              !descriptor.enumerable ||
              !("value" in descriptor)) {
            throw failure(code);
          }
          values.set(index, descriptor.value);
        }
        if (values.size !== current.length) throw failure(code);
        const output = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!values.has(index)) throw failure(code);
          output.push(visit(values.get(index), depth + 1));
        }
        return output;
      }
      if (!isPlainObject(current)) throw failure(code);
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== "string")) throw failure(code);
      const output = Object.create(null);
      for (const key of [...keys].sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw failure(code);
        }
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  }

  return JSON.stringify(visit(value, 0));
}

function canonicalClone(value, code) {
  return JSON.parse(canonicalJson(value, code));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashDomain(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\u0000", "utf8")
    .update(value)
    .digest("hex");
}

function assertHash(value, code) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw failure(code);
}

function assertTimestamp(value, code) {
  if (typeof value !== "string") throw failure(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw failure(code);
}

function normalizedPayload(value) {
  if (typeof value !== "string") throw failure("SEALED_OVERLAP_INVALID");
  return Array.from(value.normalize("NFKC").toLowerCase())
    .filter((codePoint) => LETTER_OR_NUMBER.test(codePoint))
    .join("");
}

function fourGramsFromNormalized(normalized) {
  const codePoints = Array.from(normalized);
  if (codePoints.length === 0) return new Set();
  if (codePoints.length < 4) return new Set([normalized]);
  const grams = new Set();
  for (let index = 0; index <= codePoints.length - 4; index += 1) {
    grams.add(codePoints.slice(index, index + 4).join(""));
  }
  return grams;
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) {
    if (right.has(gram)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function candidateCell(candidate) {
  return candidate.category + "|" + candidate.locale + "|" + candidate.domain;
}

function assertText(value, code) {
  if (typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
    throw failure(code);
  }
}

function validateSolver(value) {
  const solver = exactDataProperties(value, SOLVER_KEYS, "SEALED_SOLVER_SCHEMA_INVALID");
  assertText(solver.query, "SEALED_SOLVER_SCHEMA_INVALID");
  if (!Array.isArray(solver.corpus) ||
      solver.corpus.length === 0 ||
      solver.corpus.length > MAX_CORPUS_PAYLOADS_PER_CASE) {
    throw failure("SEALED_SOLVER_SCHEMA_INVALID");
  }
  const corpus = solver.corpus.map((raw) => {
    const item = exactDataProperties(raw, CORPUS_KEYS, "SEALED_SOLVER_SCHEMA_INVALID");
    assertHash(item.sourceHash, "SEALED_SOLVER_SCHEMA_INVALID");
    assertText(item.text, "SEALED_SOLVER_SCHEMA_INVALID");
    return { sourceHash: item.sourceHash, text: item.text };
  });
  const runtime = exactDataProperties(
    solver.runtimeOptions,
    RUNTIME_KEYS,
    "SEALED_SOLVER_SCHEMA_INVALID"
  );
  if (typeof runtime.refine !== "boolean" ||
      !Number.isSafeInteger(runtime.topK) ||
      runtime.topK < 1 ||
      runtime.topK > 100) {
    throw failure("SEALED_SOLVER_SCHEMA_INVALID");
  }
  const payloads = [
    { kind: "query", ordinal: 0, text: solver.query },
    ...corpus.map((item, index) => ({
      kind: "chunk",
      ordinal: index,
      text: item.text
    }))
  ].map((payload) => {
    const normalized = normalizedPayload(payload.text);
    if (normalized.length === 0) throw failure("SEALED_SOLVER_SCHEMA_INVALID");
    return {
      byteLength: Buffer.byteLength(payload.text, "utf8"),
      kind: payload.kind,
      normalized,
      ordinal: payload.ordinal
    };
  });
  return {
    payloads,
    solver: {
      corpus,
      query: solver.query,
      runtimeOptions: { refine: runtime.refine, topK: runtime.topK }
    }
  };
}

function validateAndCanonicalizePool(value) {
  if (!Array.isArray(value) || value.length !== 180) throw failure("SEALED_MATRIX_INVALID");
  const cells = new Map();
  const cases = value.map((raw) => {
    const candidate = exactDataProperties(raw, CANDIDATE_KEYS, "SEALED_MATRIX_INVALID");
    if (!CANDIDATE_CATEGORIES.includes(candidate.category) ||
        !CANDIDATE_LOCALES.includes(candidate.locale) ||
        !CANDIDATE_DOMAINS.includes(candidate.domain)) {
      throw failure("SEALED_MATRIX_INVALID");
    }
    const { payloads, solver } = validateSolver(candidate.solver);
    const scorer = canonicalClone(candidate.scorer, "SEALED_INPUT_INVALID");
    const item = {
      category: candidate.category,
      domain: candidate.domain,
      locale: candidate.locale,
      scorer,
      solver
    };
    const cell = candidateCell(item);
    cells.set(cell, (cells.get(cell) ?? 0) + 1);
    return {
      item,
      payloads,
      sortHash: hashDomain(
        "muse-recall-case-v2",
        canonicalJson(item, "SEALED_INPUT_INVALID")
      )
    };
  });
  for (const category of CANDIDATE_CATEGORIES) {
    for (const locale of CANDIDATE_LOCALES) {
      for (const domain of CANDIDATE_DOMAINS) {
        if (cells.get(category + "|" + locale + "|" + domain) !== 6) {
          throw failure("SEALED_MATRIX_INVALID");
        }
      }
    }
  }
  if (cells.size !== 30) throw failure("SEALED_MATRIX_INVALID");
  cases.sort((left, right) => {
    const leftCell = candidateCell(left.item);
    const rightCell = candidateCell(right.item);
    return leftCell < rightCell ? -1 : leftCell > rightCell ? 1 :
      left.sortHash < right.sortHash ? -1 : left.sortHash > right.sortHash ? 1 : 0;
  });
  return cases;
}

function overlapSummary(leftItems, rightItems, sameCollection, threshold) {
  let comparisons = 0;
  let excludedSameCaseComparisons = 0;
  let exactDuplicates = 0;
  let maxSimilarity = 0;
  let witnessHashes = [];
  const rightStart = sameCollection ? undefined : 0;
  for (let leftIndex = 0; leftIndex < leftItems.length; leftIndex += 1) {
    const start = rightStart === undefined ? leftIndex + 1 : rightStart;
    for (let rightIndex = start; rightIndex < rightItems.length; rightIndex += 1) {
      const left = leftItems[leftIndex];
      const right = rightItems[rightIndex];
      if (sameCollection && left.owner === right.owner) {
        excludedSameCaseComparisons += 1;
        continue;
      }
      comparisons += 1;
      if (left.normalized === right.normalized) exactDuplicates += 1;
      const similarity = jaccard(left.grams, right.grams);
      const pair = [left.hash, right.hash].sort();
      if (similarity > maxSimilarity ||
          (similarity === maxSimilarity &&
            (witnessHashes.length === 0 || pair.join("") < witnessHashes.join("")))) {
        maxSimilarity = similarity;
        witnessHashes = pair;
      }
    }
  }
  if (exactDuplicates !== 0 || maxSimilarity > threshold) {
    throw failure("SEALED_OVERLAP_INVALID");
  }
  return Object.freeze({
    comparisons,
    exactDuplicates,
    excludedSameCaseComparisons,
    maxSimilarity,
    witnessHashes: Object.freeze(witnessHashes)
  });
}

function validateOverlap(cases, priorValue) {
  if (!Array.isArray(priorValue) || priorValue.length > MAX_PRIOR_PAYLOADS) {
    throw failure("SEALED_OVERLAP_INVALID");
  }
  const poolPayloads = cases.flatMap(({ payloads }, owner) =>
    payloads.map((payload) => ({
      byteLength: payload.byteLength,
      hash: hashDomain(
        "muse-recall-overlap-payload-v2",
        canonicalJson(
          [payload.kind, payload.ordinal, payload.normalized],
          "SEALED_OVERLAP_INVALID"
        )
      ),
      normalized: payload.normalized,
      owner
    }))
  );
  const priorPayloads = priorValue.map((payload) => {
    assertText(payload, "SEALED_OVERLAP_INVALID");
    const normalized = normalizedPayload(payload);
    if (normalized.length === 0) throw failure("SEALED_OVERLAP_INVALID");
    return {
      byteLength: Buffer.byteLength(payload, "utf8"),
      hash: hashDomain("muse-recall-overlap-prior-v2", normalized),
      normalized
    };
  });
  const excludedSameCaseComparisons = cases.reduce(
    (total, entry) =>
      total + (entry.payloads.length * (entry.payloads.length - 1)) / 2,
    0
  );
  const internalComparisons =
    (poolPayloads.length * (poolPayloads.length - 1)) / 2 -
    excludedSameCaseComparisons;
  const priorComparisons = poolPayloads.length * priorPayloads.length;
  const overlapBytes = [...poolPayloads, ...priorPayloads].reduce(
    (total, payload) => total + payload.byteLength,
    0
  );
  if (poolPayloads.length > MAX_OVERLAP_PAYLOADS ||
      internalComparisons > MAX_OVERLAP_COMPARISONS ||
      priorComparisons > MAX_OVERLAP_COMPARISONS ||
      overlapBytes > MAX_OVERLAP_BYTES) {
    throw failure("SEALED_OVERLAP_INVALID");
  }
  for (const payload of [...poolPayloads, ...priorPayloads]) {
    payload.grams = fourGramsFromNormalized(payload.normalized);
  }
  const internal = overlapSummary(poolPayloads, poolPayloads, true, 0.8);
  const prior = overlapSummary(poolPayloads, priorPayloads, false, 0.35);
  if (internal.comparisons !== internalComparisons ||
      internal.excludedSameCaseComparisons !== excludedSameCaseComparisons ||
      prior.comparisons !== priorComparisons ||
      prior.excludedSameCaseComparisons !== 0) {
    throw failure("SEALED_OVERLAP_INVALID");
  }
  return Object.freeze({
    internal,
    prior
  });
}

function envelopeAad() {
  return Buffer.from(ENVELOPE_SCHEMA + "\u0000" + AES_ALGORITHM, "utf8");
}

function encryptEnvelope(plaintext, key) {
  let plainCopy;
  let keyCopy;
  let iv;
  let ciphertext;
  let tag;
  try {
    if (!Buffer.isBuffer(plaintext) || !Buffer.isBuffer(key) || key.byteLength !== AES_KEY_BYTES) {
      throw failure("SEALED_CRYPTO_FAILED");
    }
    plainCopy = Buffer.from(plaintext);
    keyCopy = Buffer.from(key);
    iv = randomBytes(AES_IV_BYTES);
    const cipher = createCipheriv(AES_ALGORITHM, keyCopy, iv, { authTagLength: AES_TAG_BYTES });
    cipher.setAAD(envelopeAad());
    ciphertext = Buffer.concat([cipher.update(plainCopy), cipher.final()]);
    tag = cipher.getAuthTag();
    return Object.freeze({
      algorithm: AES_ALGORITHM,
      authTagBase64: tag.toString("base64"),
      ciphertextBase64: ciphertext.toString("base64"),
      ciphertextSha256: sha256(ciphertext),
      ivBase64: iv.toString("base64"),
      schema: ENVELOPE_SCHEMA,
      version: 2
    });
  } catch (error) {
    throw closeError(error, "SEALED_CRYPTO_FAILED");
  } finally {
    plainCopy?.fill(0);
    keyCopy?.fill(0);
    iv?.fill(0);
    ciphertext?.fill(0);
    tag?.fill(0);
  }
}

function canonicalBase64(value, length) {
  if (typeof value !== "string") throw failure("SEALED_CRYPTO_FAILED");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (length !== undefined && bytes.length !== length)) {
    bytes.fill(0);
    throw failure("SEALED_CRYPTO_FAILED");
  }
  return bytes;
}

function validateEnvelope(value) {
  const envelope = exactDataProperties(value, ENVELOPE_KEYS, "SEALED_CRYPTO_FAILED");
  if (envelope.algorithm !== AES_ALGORITHM ||
      envelope.schema !== ENVELOPE_SCHEMA ||
      envelope.version !== 2) {
    throw failure("SEALED_CRYPTO_FAILED");
  }
  assertHash(envelope.ciphertextSha256, "SEALED_CRYPTO_FAILED");
  const iv = canonicalBase64(envelope.ivBase64, AES_IV_BYTES);
  const tag = canonicalBase64(envelope.authTagBase64, AES_TAG_BYTES);
  const ciphertext = canonicalBase64(envelope.ciphertextBase64);
  const actual = Buffer.from(sha256(ciphertext), "hex");
  const claimed = Buffer.from(envelope.ciphertextSha256, "hex");
  const matches = timingSafeEqual(actual, claimed);
  iv.fill(0);
  tag.fill(0);
  ciphertext.fill(0);
  actual.fill(0);
  claimed.fill(0);
  if (!matches) throw failure("SEALED_CRYPTO_FAILED");
  return envelope;
}

function decryptEnvelopeBytes(envelopeValue, key) {
  const envelope = validateEnvelope(envelopeValue);
  let keyCopy;
  let iv;
  let tag;
  let ciphertext;
  let head;
  let tail;
  try {
    if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
      throw failure("SEALED_CRYPTO_FAILED");
    }
    keyCopy = Buffer.from(key);
    iv = canonicalBase64(envelope.ivBase64, AES_IV_BYTES);
    tag = canonicalBase64(envelope.authTagBase64, AES_TAG_BYTES);
    ciphertext = canonicalBase64(envelope.ciphertextBase64);
    const decipher = createDecipheriv(AES_ALGORITHM, keyCopy, iv, { authTagLength: AES_TAG_BYTES });
    decipher.setAAD(envelopeAad());
    decipher.setAuthTag(tag);
    head = decipher.update(ciphertext);
    tail = decipher.final();
    return Buffer.concat([head, tail]);
  } catch (error) {
    throw closeError(error, "SEALED_CRYPTO_FAILED");
  } finally {
    keyCopy?.fill(0);
    iv?.fill(0);
    tag?.fill(0);
    ciphertext?.fill(0);
    head?.fill(0);
    tail?.fill(0);
  }
}

function rootSnapshot(rootInput) {
  try {
    if (typeof rootInput !== "string" || rootInput.length === 0) {
      throw failure("SEALED_ROOT_INVALID");
    }
    const requested = resolve(rootInput);
    const requestedInfo = lstatSync(requested);
    const actual = realpathSync.native(requested);
    const info = lstatSync(actual);
    if (requestedInfo.isSymbolicLink() ||
        !requestedInfo.isDirectory() ||
        (requestedInfo.mode & 0o777) !== ROOT_MODE ||
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        (info.mode & 0o777) !== ROOT_MODE ||
        requestedInfo.dev !== info.dev ||
        requestedInfo.ino !== info.ino) {
      throw failure("SEALED_ROOT_INVALID");
    }
    return Object.freeze({ dev: info.dev, ino: info.ino, path: actual });
  } catch (error) {
    throw closeError(error, "SEALED_ROOT_INVALID");
  }
}

async function assertSameRoot(root) {
  try {
    const [info, actual] = await Promise.all([lstat(root.path), realpath(root.path)]);
    if (actual !== root.path ||
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        (info.mode & 0o777) !== ROOT_MODE ||
        info.dev !== root.dev ||
        info.ino !== root.ino) {
      throw failure("SEALED_ROOT_INVALID");
    }
  } catch (error) {
    throw closeError(error, "SEALED_ROOT_INVALID");
  }
}

function safeErrno(error) {
  try {
    return error !== null && typeof error === "object" && typeof error.code === "string"
      ? error.code
      : undefined;
  } catch {
    return undefined;
  }
}

async function syncRoot(root) {
  let handle;
  let failed = false;
  try {
    handle = await open(
      root.path,
      FS_CONSTANTS.O_RDONLY |
        (FS_CONSTANTS.O_DIRECTORY ?? 0) |
        (FS_CONSTANTS.O_NOFOLLOW ?? 0)
    );
    await handle.sync();
  } catch {
    failed = true;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      failed = true;
    }
  }
  if (failed) throw failure("SEALED_ROOT_IO_FAILED");
}

async function durableExclusiveFile(root, path, bytes, code) {
  let handle;
  let failed = false;
  try {
    handle = await open(
      path,
      FS_CONSTANTS.O_CREAT |
        FS_CONSTANTS.O_EXCL |
        FS_CONSTANTS.O_WRONLY |
        (FS_CONSTANTS.O_NOFOLLOW ?? 0),
      FILE_MODE
    );
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== FILE_MODE) throw failure(code);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    failed = true;
    if (knownFailure(error) !== undefined) {
      try {
        await handle?.close();
      } catch {
        // The operation already failed closed.
      }
      throw error;
    }
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      failed = true;
    }
  }
  if (failed) throw failure(code);
  await syncRoot(root);
}

async function readPrivateFile(root, path, optional, code) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (optional && safeErrno(error) === "ENOENT") return undefined;
    throw failure(code);
  }
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o777) !== FILE_MODE) {
    throw failure(code);
  }
  let handle;
  let bytes;
  let failed = false;
  try {
    handle = await open(path, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    const after = await handle.stat();
    if (!after.isFile() ||
        (after.mode & 0o777) !== FILE_MODE ||
        before.dev !== after.dev ||
        before.ino !== after.ino) {
      throw failure(code);
    }
    bytes = await handle.readFile();
  } catch (error) {
    if (knownFailure(error) !== undefined) throw error;
    failed = true;
  }
  try {
    await handle?.close();
  } catch {
    failed = true;
  }
  if (failed || bytes === undefined) throw failure(code);
  await assertSameRoot(root);
  return bytes;
}

function tupleFromEntry(entry) {
  const tuple = Object.create(null);
  for (const key of TUPLE_KEYS) tuple[key] = entry[key];
  return tuple;
}

function emptySelectionTuple(base) {
  return {
    claimHash: ZERO_HASH,
    finalDatasetHash: ZERO_HASH,
    metadataHash: base.metadataHash,
    poolCiphertextHash: base.poolCiphertextHash,
    poolEnvelopeHash: base.poolEnvelopeHash,
    poolHash: base.poolHash,
    seedCommitment: ZERO_HASH,
    selectedEnvelopeHash: ZERO_HASH
  };
}

function entryHashContent(entry) {
  const content = {
    ...tupleFromEntry(entry),
    previousHash: entry.previousHash,
    schema: entry.schema,
    sequence: entry.sequence,
    status: entry.status,
    timestamp: entry.timestamp
  };
  return content;
}

function makeEntry(status, tuple, previous) {
  if (!STATUSES.has(status)) throw failure("SEALED_LEDGER_INVALID");
  const tupleData = exactDataProperties(tuple, TUPLE_KEYS, "SEALED_LEDGER_INVALID");
  for (const key of TUPLE_KEYS) assertHash(tupleData[key], "SEALED_LEDGER_INVALID");
  const content = {
    ...tupleData,
    previousHash: previous?.entryHash ?? ZERO_HASH,
    schema: LEDGER_SCHEMA,
    sequence: previous === undefined ? 0 : previous.sequence + 1,
    status,
    timestamp: new Date().toISOString()
  };
  const entry = {
    ...content,
    entryHash: sha256(canonicalJson(content, "SEALED_LEDGER_INVALID"))
  };
  return Object.freeze(entry);
}

function validateEntry(value) {
  const entry = exactDataProperties(value, ENTRY_KEYS, "SEALED_LEDGER_INVALID");
  if (entry.schema !== LEDGER_SCHEMA ||
      !STATUSES.has(entry.status) ||
      !Number.isSafeInteger(entry.sequence) ||
      entry.sequence < 0) {
    throw failure("SEALED_LEDGER_INVALID");
  }
  for (const key of [...TUPLE_KEYS, "entryHash", "previousHash"]) {
    assertHash(entry[key], "SEALED_LEDGER_INVALID");
  }
  assertTimestamp(entry.timestamp, "SEALED_LEDGER_INVALID");
  const calculated = Buffer.from(
    sha256(canonicalJson(entryHashContent(entry), "SEALED_LEDGER_INVALID")),
    "hex"
  );
  const claimed = Buffer.from(entry.entryHash, "hex");
  const matches = timingSafeEqual(calculated, claimed);
  calculated.fill(0);
  claimed.fill(0);
  if (!matches) throw failure("SEALED_LEDGER_INVALID");
  return Object.freeze({ ...entry });
}

function sameBaseTuple(left, right) {
  return left.poolHash === right.poolHash &&
    left.metadataHash === right.metadataHash &&
    left.poolEnvelopeHash === right.poolEnvelopeHash &&
    left.poolCiphertextHash === right.poolCiphertextHash;
}

function sameSelectionTuple(left, right) {
  return sameBaseTuple(left, right) &&
    left.finalDatasetHash === right.finalDatasetHash &&
    left.seedCommitment === right.seedCommitment &&
    left.selectedEnvelopeHash === right.selectedEnvelopeHash &&
    left.claimHash === right.claimHash;
}

function sameDatasetBinding(left, right) {
  return sameBaseTuple(left, right) &&
    left.finalDatasetHash === right.finalDatasetHash &&
    left.seedCommitment === right.seedCommitment &&
    left.selectedEnvelopeHash === right.selectedEnvelopeHash;
}

function hasEmptySelectionTuple(entry) {
  return entry.finalDatasetHash === ZERO_HASH &&
    entry.seedCommitment === ZERO_HASH &&
    entry.selectedEnvelopeHash === ZERO_HASH &&
    entry.claimHash === ZERO_HASH;
}

function validTransition(previous, next) {
  if (previous.status === "sealed" && (next.status === "consuming" || next.status === "burned")) {
    return next.status === "burned" && hasEmptySelectionTuple(next)
      ? sameBaseTuple(previous, next)
      : sameBaseTuple(previous, next) && !hasEmptySelectionTuple(next);
  }
  if (previous.status === "consuming" &&
      (next.status === "passed" || next.status === "burned")) {
    return sameSelectionTuple(previous, next);
  }
  if (previous.status === "passed" && next.status === "reproduction-consuming") {
    return sameSelectionTuple(previous, next);
  }
  if (previous.status === "passed" && next.status === "burned") {
    return sameSelectionTuple(previous, next);
  }
  if (previous.status === "reproduction-consuming" &&
      (next.status === "reproduced" || next.status === "burned")) {
    return sameSelectionTuple(previous, next);
  }
  return false;
}

function validateLedger(value) {
  if (!Array.isArray(value)) throw failure("SEALED_LEDGER_INVALID");
  const latest = new Map();
  let previous;
  let priorTime = -Infinity;
  for (const raw of value) {
    const entry = validateEntry(raw);
    if (entry.sequence !== (previous === undefined ? 0 : previous.sequence + 1) ||
        entry.previousHash !== (previous?.entryHash ?? ZERO_HASH)) {
      throw failure("SEALED_LEDGER_INVALID");
    }
    const time = new Date(entry.timestamp).valueOf();
    if (time < priorTime) throw failure("SEALED_LEDGER_INVALID");
    priorTime = time;
    const prior = latest.get(entry.poolHash);
    if (prior === undefined) {
      if (entry.status !== "sealed" && entry.status !== "burned") {
        throw failure("SEALED_LEDGER_INVALID");
      }
      if (!hasEmptySelectionTuple(entry)) throw failure("SEALED_LEDGER_INVALID");
    } else if (!validTransition(prior, entry)) {
      throw failure("SEALED_LEDGER_INVALID");
    }
    latest.set(entry.poolHash, entry);
    previous = entry;
  }
  return Object.freeze({
    entries: value.map((entry) => Object.freeze({ ...entry })),
    headHash: previous?.entryHash ?? ZERO_HASH,
    latest
  });
}

async function readLedger(root, paths) {
  const bytes = await readPrivateFile(root, paths.ledger, true, "SEALED_LEDGER_IO_FAILED");
  if (bytes === undefined) return validateLedger([]);
  try {
    const text = bytes.toString("utf8");
    if (text.length === 0 || !text.endsWith("\n")) throw failure("SEALED_LEDGER_INVALID");
    const entries = text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
    return validateLedger(entries);
  } catch (error) {
    throw closeError(error, "SEALED_LEDGER_INVALID");
  } finally {
    bytes.fill(0);
  }
}

async function writeLedger(root, paths, entries) {
  const validated = validateLedger(entries);
  const bytes = Buffer.from(
    validated.entries.map((entry) => canonicalJson(entry, "SEALED_LEDGER_INVALID")).join("\n") + "\n",
    "utf8"
  );
  try {
    const existing = await readPrivateFile(root, paths.ledger, true, "SEALED_LEDGER_IO_FAILED");
    if (existing === undefined) {
      await durableExclusiveFile(root, paths.ledger, bytes, "SEALED_LEDGER_IO_FAILED");
      return validated;
    }
    existing.fill(0);
    const temporary = join(root.path, ".registry-" + validated.headHash + ".tmp");
    await durableExclusiveFile(root, temporary, bytes, "SEALED_LEDGER_IO_FAILED");
    await rename(temporary, paths.ledger);
    await syncRoot(root);
    return validated;
  } catch (error) {
    throw closeError(error, "SEALED_LEDGER_IO_FAILED");
  } finally {
    bytes.fill(0);
  }
}

function makePaths(root) {
  return Object.freeze({
    ledger: join(root.path, "registry.jsonl"),
    lock: join(root.path, ".mutation.lock"),
    envelope: (poolHash) => join(root.path, "pool-" + poolHash + ".envelope"),
    reproductionClaim: (poolHash) => join(root.path, "reproduction-" + poolHash + ".claim"),
    sealClaim: (poolHash) => join(root.path, "pool-" + poolHash + ".claim"),
    selectedEnvelope: (poolHash, datasetHash) => join(
      root.path,
      "selected-" + poolHash + "-" + datasetHash + ".envelope"
    ),
    selectionClaim: (poolHash) => join(root.path, "selection-" + poolHash + ".claim")
  });
}

function lockContent(pid, token) {
  return { pid, schema: LOCK_SCHEMA, token };
}

function validateLock(value) {
  const lock = exactDataProperties(value, ["pid", "schema", "token"], "SEALED_LOCK_FAILED");
  if (lock.schema !== LOCK_SCHEMA ||
      !Number.isSafeInteger(lock.pid) ||
      lock.pid <= 0 ||
      typeof lock.token !== "string" ||
      !/^[a-f0-9]{32}$/u.test(lock.token)) {
    throw failure("SEALED_LOCK_FAILED");
  }
  return lock;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return safeErrno(error) !== "ESRCH";
  }
}

async function recoverDeadLock(root, paths) {
  const bytes = await readPrivateFile(root, paths.lock, true, "SEALED_LOCK_FAILED");
  if (bytes === undefined) return undefined;
  let guardPath;
  try {
    let lock;
    try {
      lock = validateLock(parseCanonicalBytes(bytes, "SEALED_LOCK_FAILED"));
    } catch (error) {
      // O_EXCL publishes the directory entry before the owning writer has
      // necessarily completed the small lock payload. Treat that transient as
      // contended; a persistently malformed lock still exhausts the bounded
      // acquisition loop and fails closed.
      if (knownFailure(error) === "SEALED_LOCK_FAILED") return undefined;
      throw error;
    }
    if (processIsAlive(lock.pid)) return undefined;
    const lockDigest = hashDomain("muse-recall-dead-lock-v2", bytes);
    guardPath = join(root.path, ".dead-lock-" + lockDigest + ".guard");
    try {
      await link(paths.lock, guardPath);
    } catch (error) {
      if (safeErrno(error) === "EEXIST" || safeErrno(error) === "ENOENT") return undefined;
      throw failure("SEALED_LOCK_FAILED");
    }
    const [mainInfo, guardInfo] = await Promise.all([lstat(paths.lock), lstat(guardPath)]);
    if (mainInfo.dev !== guardInfo.dev || mainInfo.ino !== guardInfo.ino) {
      throw failure("SEALED_LOCK_FAILED");
    }
    await unlink(paths.lock);
    await syncRoot(root);
    return guardPath;
  } finally {
    bytes.fill(0);
  }
}

async function withMutationLock(root, paths, operation) {
  await assertSameRoot(root);
  let acquired = false;
  const recoveredGuards = [];
  const ownerBytes = Buffer.from(
    canonicalJson(
      lockContent(process.pid, randomBytes(16).toString("hex")),
      "SEALED_LOCK_FAILED"
    ),
    "utf8"
  );
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await durableExclusiveFile(
        root,
        paths.lock,
        ownerBytes,
        "SEALED_LOCK_FAILED"
      );
      acquired = true;
      break;
    } catch (error) {
      if (safeErrno(error) !== "EEXIST" && knownFailure(error) !== "SEALED_LOCK_FAILED") {
        throw closeError(error, "SEALED_LOCK_FAILED");
      }
      const exists = await lstat(paths.lock).then(() => true, (cause) => {
        if (safeErrno(cause) === "ENOENT") return false;
        throw failure("SEALED_LOCK_FAILED");
      });
      if (!exists) continue;
      const recovered = await recoverDeadLock(root, paths);
      if (recovered !== undefined) {
        recoveredGuards.push(recovered);
        continue;
      }
      await delay(LOCK_DELAY_MS);
    }
  }
  ownerBytes.fill(0);
  if (!acquired) throw failure("SEALED_LOCK_FAILED");
  for (const guardPath of recoveredGuards) {
    try {
      await unlink(guardPath);
    } catch (error) {
      if (safeErrno(error) !== "ENOENT") throw failure("SEALED_LOCK_FAILED");
    }
  }
  if (recoveredGuards.length > 0) await syncRoot(root);
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  let releaseFailed = false;
  try {
    await unlink(paths.lock);
    await syncRoot(root);
  } catch {
    releaseFailed = true;
  }
  if (operationError !== undefined) throw operationError;
  if (releaseFailed) throw failure("SEALED_LOCK_FAILED");
  return result;
}

function parseSealInput(input) {
  const data = exactDataProperties(input, INPUT_KEYS, "SEALED_INPUT_INVALID");
  const metadataBytes = canonicalJson(data.metadata, "SEALED_INPUT_INVALID");
  const cases = validateAndCanonicalizePool(data.pool);
  const overlap = validateOverlap(cases, data.priorPayloads);
  const canonicalCases = cases.map(({ item }) => item);
  const poolHash = hashDomain(
    "muse-recall-pool-content-v2",
    canonicalJson(canonicalCases, "SEALED_INPUT_INVALID")
  );
  return {
    canonicalCases,
    metadataHash: hashDomain("muse-recall-metadata-v2", metadataBytes),
    overlap,
    poolHash
  };
}

function assignOpaqueIds(cases) {
  const ids = new Set();
  return cases.map((item) => {
    let opaqueId;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      opaqueId = randomBytes(16).toString("hex");
      if (!ids.has(opaqueId)) break;
      opaqueId = undefined;
    }
    if (opaqueId === undefined) throw failure("SEALED_CRYPTO_FAILED");
    ids.add(opaqueId);
    return {
      category: item.category,
      domain: item.domain,
      locale: item.locale,
      opaqueId,
      scorer: item.scorer,
      solver: {
        corpus: item.solver.corpus,
        opaqueId,
        query: item.solver.query,
        runtimeOptions: item.solver.runtimeOptions
      }
    };
  });
}

function validateSealedPool(value, expectedPoolHash) {
  const pool = exactDataProperties(value, ["cases", "poolHash", "schema"], "SEALED_CRYPTO_FAILED");
  if (pool.schema !== POOL_SCHEMA || pool.poolHash !== expectedPoolHash || !Array.isArray(pool.cases)) {
    throw failure("SEALED_CRYPTO_FAILED");
  }
  if (pool.cases.length !== 180) throw failure("SEALED_CRYPTO_FAILED");
  const ids = new Set();
  for (const raw of pool.cases) {
    const candidate = exactDataProperties(raw, SEALED_CANDIDATE_KEYS, "SEALED_CRYPTO_FAILED");
    const solver = exactDataProperties(candidate.solver, SEALED_SOLVER_KEYS, "SEALED_CRYPTO_FAILED");
    if (typeof candidate.opaqueId !== "string" ||
        !/^[a-f0-9]{32}$/u.test(candidate.opaqueId) ||
        ids.has(candidate.opaqueId) ||
        solver.opaqueId !== candidate.opaqueId) {
      throw failure("SEALED_CRYPTO_FAILED");
    }
    ids.add(candidate.opaqueId);
  }
  return pool;
}

function sealMarkerContent(base) {
  return {
    metadataHash: base.metadataHash,
    poolCiphertextHash: base.poolCiphertextHash,
    poolEnvelopeHash: base.poolEnvelopeHash,
    poolHash: base.poolHash,
    schema: SEAL_CLAIM_SCHEMA
  };
}

function parseCanonicalBytes(bytes, code) {
  try {
    const text = bytes.toString("utf8");
    const value = JSON.parse(text);
    if (canonicalJson(value, code) !== text) throw failure(code);
    return value;
  } catch (error) {
    throw closeError(error, code);
  }
}

function validateSealMarker(value, expected) {
  const marker = exactDataProperties(
    value,
    ["metadataHash", "poolCiphertextHash", "poolEnvelopeHash", "poolHash", "schema"],
    "SEALED_SEAL_IO_FAILED"
  );
  for (const key of [
    "metadataHash",
    "poolCiphertextHash",
    "poolEnvelopeHash",
    "poolHash"
  ]) {
    assertHash(marker[key], "SEALED_SEAL_IO_FAILED");
  }
  if (marker.schema !== SEAL_CLAIM_SCHEMA ||
      !sameBaseTuple(marker, expected)) {
    throw failure("SEALED_SEAL_IO_FAILED");
  }
  return marker;
}

function claimHashContent(schema, parentHeadHash, tuple) {
  return {
    finalDatasetHash: tuple.finalDatasetHash,
    metadataHash: tuple.metadataHash,
    parentHeadHash,
    poolCiphertextHash: tuple.poolCiphertextHash,
    poolEnvelopeHash: tuple.poolEnvelopeHash,
    poolHash: tuple.poolHash,
    schema,
    seedCommitment: tuple.seedCommitment,
    selectedEnvelopeHash: tuple.selectedEnvelopeHash
  };
}

function createClaim(schema, parentHeadHash, tuple) {
  assertHash(parentHeadHash, "SEALED_CLAIM_IO_FAILED");
  const content = claimHashContent(schema, parentHeadHash, tuple);
  const claimHash = hashDomain(
    "muse-recall-lifecycle-claim-v2",
    canonicalJson(content, "SEALED_CLAIM_IO_FAILED")
  );
  return Object.freeze({ ...content, claimHash });
}

function validateClaim(value, schema, expectedBase) {
  const claim = exactDataProperties(
    value,
    [
      "claimHash",
      "finalDatasetHash",
      "metadataHash",
      "parentHeadHash",
      "poolCiphertextHash",
      "poolEnvelopeHash",
      "poolHash",
      "schema",
      "seedCommitment",
      "selectedEnvelopeHash"
    ],
    "SEALED_CLAIM_IO_FAILED"
  );
  if (claim.schema !== schema || !sameBaseTuple(claim, expectedBase)) {
    throw failure("SEALED_CLAIM_IO_FAILED");
  }
  for (const key of [
    "claimHash",
    "finalDatasetHash",
    "parentHeadHash",
    "seedCommitment",
    "selectedEnvelopeHash"
  ]) {
    assertHash(claim[key], "SEALED_CLAIM_IO_FAILED");
  }
  const calculated = hashDomain(
    "muse-recall-lifecycle-claim-v2",
    canonicalJson(
      claimHashContent(schema, claim.parentHeadHash, claim),
      "SEALED_CLAIM_IO_FAILED"
    )
  );
  const left = Buffer.from(calculated, "hex");
  const right = Buffer.from(claim.claimHash, "hex");
  const matches = timingSafeEqual(left, right);
  left.fill(0);
  right.fill(0);
  if (!matches) throw failure("SEALED_CLAIM_IO_FAILED");
  return Object.freeze({ ...claim });
}

function tupleFromClaim(claim) {
  return {
    claimHash: claim.claimHash,
    finalDatasetHash: claim.finalDatasetHash,
    metadataHash: claim.metadataHash,
    poolCiphertextHash: claim.poolCiphertextHash,
    poolEnvelopeHash: claim.poolEnvelopeHash,
    poolHash: claim.poolHash,
    seedCommitment: claim.seedCommitment,
    selectedEnvelopeHash: claim.selectedEnvelopeHash
  };
}

function knownLedgerHead(ledger, headHash) {
  return headHash === ZERO_HASH || ledger.entries.some((entry) => entry.entryHash === headHash);
}

function aggregateCounts() {
  return {
    cases: 90,
    casesPerCell: 3,
    categoryCounts: Object.freeze({ absent: 30, correction: 30, ordinary: 30 }),
    cells: 30,
    domainCounts: Object.freeze({
      health: 18,
      life: 18,
      preference: 18,
      reference: 18,
      work: 18
    }),
    localeCounts: Object.freeze({ en: 45, ko: 45 })
  };
}

function selectSolverViews(pool, seed) {
  const groups = new Map();
  for (const item of pool.cases) {
    const key = candidateCell(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const selected = [];
  for (const category of CANDIDATE_CATEGORIES) {
    for (const locale of CANDIDATE_LOCALES) {
      for (const domain of CANDIDATE_DOMAINS) {
        const key = category + "|" + locale + "|" + domain;
        const group = groups.get(key);
        if (!Array.isArray(group) || group.length !== 6) throw failure("SEALED_CRYPTO_FAILED");
        const ranked = group.map((item) => ({
          item,
          rank: createHmac("sha256", seed)
            .update(
              canonicalJson([pool.poolHash, key, item.opaqueId], "SEALED_CRYPTO_FAILED"),
              "utf8"
            )
            .digest("hex")
        }));
        ranked.sort((left, right) =>
          left.rank < right.rank ? -1 :
            left.rank > right.rank ? 1 :
              left.item.opaqueId < right.item.opaqueId ? -1 :
                left.item.opaqueId > right.item.opaqueId ? 1 : 0
        );
        for (const { item } of ranked.slice(0, 3)) {
          selected.push({
            opaqueId: item.opaqueId,
            solver: canonicalClone(item.solver, "SEALED_CRYPTO_FAILED")
          });
        }
      }
    }
  }
  if (selected.length !== 90) throw failure("SEALED_CRYPTO_FAILED");
  return selected;
}

function validateSelectedSolverViews(value, expectedHash) {
  if (!Array.isArray(value) || value.length !== 90) throw failure("SEALED_CRYPTO_FAILED");
  const ids = new Set();
  for (const raw of value) {
    const item = exactDataProperties(raw, ["opaqueId", "solver"], "SEALED_CRYPTO_FAILED");
    const solver = exactDataProperties(
      item.solver,
      SEALED_SOLVER_KEYS,
      "SEALED_CRYPTO_FAILED"
    );
    if (typeof item.opaqueId !== "string" ||
        !/^[a-f0-9]{32}$/u.test(item.opaqueId) ||
        solver.opaqueId !== item.opaqueId ||
        ids.has(item.opaqueId)) {
      throw failure("SEALED_CRYPTO_FAILED");
    }
    ids.add(item.opaqueId);
    const solverWithoutId = {
      corpus: solver.corpus,
      query: solver.query,
      runtimeOptions: solver.runtimeOptions
    };
    validateSolver(solverWithoutId);
  }
  const canonical = canonicalJson(value, "SEALED_CRYPTO_FAILED");
  if (sha256(canonical) !== expectedHash) throw failure("SEALED_CRYPTO_FAILED");
  return value;
}

async function readAndValidateClaim(root, path, schema, expectedBase) {
  const bytes = await readPrivateFile(root, path, true, "SEALED_CLAIM_IO_FAILED");
  if (bytes === undefined) return undefined;
  try {
    return validateClaim(
      parseCanonicalBytes(bytes, "SEALED_CLAIM_IO_FAILED"),
      schema,
      expectedBase
    );
  } finally {
    bytes.fill(0);
  }
}

async function readAndValidateSealMarker(root, path, expectedBase) {
  const bytes = await readPrivateFile(root, path, false, "SEALED_SEAL_IO_FAILED");
  try {
    return validateSealMarker(
      parseCanonicalBytes(bytes, "SEALED_SEAL_IO_FAILED"),
      expectedBase
    );
  } finally {
    bytes.fill(0);
  }
}

async function reconcileLocked(root, paths, hasSealedCapability) {
  let ledger = await readLedger(root, paths);
  let burnedCount = 0;
  const rootNames = await readdir(root.path);
  const markerPattern = /^pool-([a-f0-9]{64})\.claim$/u;
  const markerPoolHashes = rootNames
    .map((name) => markerPattern.exec(name))
    .filter((match) => match !== null)
    .map((match) => match[1])
    .sort();

  // A durable seal reservation without a ledger entry is a burned pool, never
  // an invitation to regenerate a new id/key/ciphertext tuple.
  for (const poolHash of markerPoolHashes) {
    if (ledger.latest.has(poolHash)) continue;
    let markerBytes;
    try {
      markerBytes = await readPrivateFile(
        root,
        paths.sealClaim(poolHash),
        false,
        "SEALED_SEAL_IO_FAILED"
      );
      const marker = parseCanonicalBytes(markerBytes, "SEALED_SEAL_IO_FAILED");
      validateSealMarker(marker, marker);
      const burned = makeEntry(
        "burned",
        emptySelectionTuple(marker),
        ledger.entries.at(-1)
      );
      ledger = await writeLedger(root, paths, [...ledger.entries, burned]);
      burnedCount += 1;
    } finally {
      markerBytes?.fill(0);
    }
  }

  const pools = [...ledger.latest.keys()].sort();
  for (const poolHash of pools) {
    const current = ledger.latest.get(poolHash);
    await readAndValidateSealMarker(root, paths.sealClaim(poolHash), current);

    if (current.status === "sealed") {
      const claim = await readAndValidateClaim(
        root,
        paths.selectionClaim(poolHash),
        SELECTION_CLAIM_SCHEMA,
        current
      );
      if (claim === undefined && hasSealedCapability(current)) continue;
      if (claim === undefined) {
        const burned = makeEntry(
          "burned",
          tupleFromEntry(current),
          ledger.entries.at(-1)
        );
        ledger = await writeLedger(root, paths, [...ledger.entries, burned]);
        burnedCount += 1;
        continue;
      }
      if (!knownLedgerHead(ledger, claim.parentHeadHash)) {
        throw failure("SEALED_CLAIM_IO_FAILED");
      }
      const claimTuple = tupleFromClaim(claim);
      if (hasEmptySelectionTuple(claimTuple)) throw failure("SEALED_CLAIM_IO_FAILED");
      const burned = makeEntry("burned", claimTuple, ledger.entries.at(-1));
      ledger = await writeLedger(root, paths, [...ledger.entries, burned]);
      burnedCount += 1;
      continue;
    }

    if (current.status === "consuming") {
      const claim = await readAndValidateClaim(
        root,
        paths.selectionClaim(poolHash),
        SELECTION_CLAIM_SCHEMA,
        current
      );
      if (claim === undefined ||
          !knownLedgerHead(ledger, claim.parentHeadHash) ||
          !sameSelectionTuple(current, tupleFromClaim(claim))) {
        throw failure("SEALED_CLAIM_IO_FAILED");
      }
      const burned = makeEntry("burned", tupleFromEntry(current), ledger.entries.at(-1));
      ledger = await writeLedger(root, paths, [...ledger.entries, burned]);
      burnedCount += 1;
      continue;
    }

    if (current.status === "passed") {
      const claim = await readAndValidateClaim(
        root,
        paths.reproductionClaim(poolHash),
        REPRODUCTION_CLAIM_SCHEMA,
        current
      );
      if (claim === undefined) continue;
      if (!knownLedgerHead(ledger, claim.parentHeadHash) ||
          !sameDatasetBinding(current, claim)) {
        throw failure("SEALED_CLAIM_IO_FAILED");
      }
      const burned = makeEntry("burned", tupleFromEntry(current), ledger.entries.at(-1));
      ledger = await writeLedger(root, paths, [...ledger.entries, burned]);
      burnedCount += 1;
      continue;
    }

    if (current.status === "reproduction-consuming") {
      const claim = await readAndValidateClaim(
        root,
        paths.reproductionClaim(poolHash),
        REPRODUCTION_CLAIM_SCHEMA,
        current
      );
      if (claim === undefined ||
          !knownLedgerHead(ledger, claim.parentHeadHash) ||
          !sameDatasetBinding(current, claim)) {
        throw failure("SEALED_CLAIM_IO_FAILED");
      }
      const burned = makeEntry("burned", tupleFromEntry(current), ledger.entries.at(-1));
      ledger = await writeLedger(root, paths, [...ledger.entries, burned]);
      burnedCount += 1;
    }
  }

  return Object.freeze({ burnedCount, headHash: ledger.headHash });
}

export function createSealedQualificationStore(trustedRoot) {
  try {
    const root = rootSnapshot(trustedRoot);
    const paths = makePaths(root);
    const sealedCapabilities = new WeakMap();
    const openSealedCapabilities = new Map();
    const passedCapabilities = new WeakMap();

    const sealPoolOnce = (input) => closedAsync(async () => {
      await assertSameRoot(root);
      const parsed = parseSealInput(input);
      const sealedCases = assignOpaqueIds(parsed.canonicalCases);
      const plaintext = Buffer.from(
        canonicalJson(
          { cases: sealedCases, poolHash: parsed.poolHash, schema: POOL_SCHEMA },
          "SEALED_INPUT_INVALID"
        ),
        "utf8"
      );
      const key = randomBytes(AES_KEY_BYTES);
      let keyTransferred = false;
      let envelopeBytes;
      try {
        const envelope = encryptEnvelope(plaintext, key);
        envelopeBytes = Buffer.from(
          canonicalJson(envelope, "SEALED_CRYPTO_FAILED"),
          "utf8"
        );
        const base = {
          metadataHash: parsed.metadataHash,
          poolCiphertextHash: envelope.ciphertextSha256,
          poolEnvelopeHash: sha256(envelopeBytes),
          poolHash: parsed.poolHash
        };
        await withMutationLock(root, paths, async () => {
          const ledger = await readLedger(root, paths);
          const marker = await readPrivateFile(
            root,
            paths.sealClaim(base.poolHash),
            true,
            "SEALED_SEAL_IO_FAILED"
          );
          if (ledger.latest.has(base.poolHash) || marker !== undefined) {
            marker?.fill(0);
            throw failure("SEALED_LIFECYCLE_CLOSED");
          }
          await durableExclusiveFile(
            root,
            paths.sealClaim(base.poolHash),
            Buffer.from(canonicalJson(sealMarkerContent(base), "SEALED_SEAL_IO_FAILED"), "utf8"),
            "SEALED_SEAL_IO_FAILED"
          );
          await durableExclusiveFile(
            root,
            paths.envelope(base.poolHash),
            envelopeBytes,
            "SEALED_SEAL_IO_FAILED"
          );
          const sealedEntry = makeEntry("sealed", emptySelectionTuple(base), ledger.entries.at(-1));
          await writeLedger(root, paths, [...ledger.entries, sealedEntry]);
        });
        const sealedHandle = Object.freeze(function sealedPoolCapability() {
          throw failure("SEALED_LIFECYCLE_CLOSED");
        });
        const capability = {
          base: Object.freeze({ ...base }),
          handle: sealedHandle,
          key,
          used: false
        };
        const receipt = Object.freeze({
          cases: 180,
          casesPerCell: 6,
          cells: 30,
          metadataHash: base.metadataHash,
          overlap: parsed.overlap,
          poolCiphertextHash: base.poolCiphertextHash,
          poolEnvelopeHash: base.poolEnvelopeHash,
          poolHash: base.poolHash,
          sealedHandle
        });
        sealedCapabilities.set(sealedHandle, capability);
        openSealedCapabilities.set(base.poolHash, capability);
        keyTransferred = true;
        return receipt;
      } finally {
        if (!keyTransferred) key.fill(0);
        envelopeBytes?.fill(0);
        plaintext.fill(0);
      }
    });

    const selectFinal90Once = (handle, consume) => {
      let capability;
      try {
        if (typeof handle !== "function") throw failure("SEALED_LIFECYCLE_CLOSED");
        capability = sealedCapabilities.get(handle);
        if (capability === undefined || capability.used) {
          throw failure("SEALED_LIFECYCLE_CLOSED");
        }
        // Reservation is synchronous and precedes the first await. Invalid
        // callbacks and every later failure therefore consume the capability.
        capability.used = true;
        sealedCapabilities.delete(handle);
        if (openSealedCapabilities.get(capability.base.poolHash) === capability) {
          openSealedCapabilities.delete(capability.base.poolHash);
        }
      } catch (error) {
        return Promise.reject(closeError(error, "SEALED_LIFECYCLE_CLOSED"));
      }
      return closedAsync(async () => {
      if (typeof consume !== "function") throw failure("SEALED_NETWORK_CALLBACK_FAILED");
      let selectedBytes;
      let reproductionKey;
      let selectedPayload;
      let lifecycle;
      let callbackPassed = false;
      let callbackFailed = false;
      try {
        lifecycle = await withMutationLock(root, paths, async () => {
          const ledger = await readLedger(root, paths);
          const sealed = ledger.latest.get(capability.base.poolHash);
          if (sealed === undefined ||
              sealed.status !== "sealed" ||
              !sameBaseTuple(sealed, capability.base)) {
            throw failure("SEALED_LIFECYCLE_CLOSED");
          }

          let markerBytes;
          let envelopeBytes;
          let poolPlaintext;
          let seed;
          let localSelectedBytes;
          let localReproductionKey;
          try {
            markerBytes = await readPrivateFile(
              root,
              paths.sealClaim(sealed.poolHash),
              false,
              "SEALED_SEAL_IO_FAILED"
            );
            validateSealMarker(
              parseCanonicalBytes(markerBytes, "SEALED_SEAL_IO_FAILED"),
              sealed
            );
            envelopeBytes = await readPrivateFile(
              root,
              paths.envelope(sealed.poolHash),
              false,
              "SEALED_SEAL_IO_FAILED"
            );
            if (sha256(envelopeBytes) !== sealed.poolEnvelopeHash) {
              throw failure("SEALED_CRYPTO_FAILED");
            }
            const envelope = parseCanonicalBytes(envelopeBytes, "SEALED_CRYPTO_FAILED");
            validateEnvelope(envelope);
            if (envelope.ciphertextSha256 !== sealed.poolCiphertextHash) {
              throw failure("SEALED_CRYPTO_FAILED");
            }
            poolPlaintext = decryptEnvelopeBytes(envelope, capability.key);
            capability.key.fill(0);
            const pool = validateSealedPool(
              parseCanonicalBytes(poolPlaintext, "SEALED_CRYPTO_FAILED"),
              sealed.poolHash
            );

            // The seed does not exist until the durable seal and exact envelope
            // have been reread and authenticated with the in-memory capability.
            seed = randomBytes(32);
            const selected = selectSolverViews(pool, seed);
            localSelectedBytes = Buffer.from(
              canonicalJson(selected, "SEALED_CRYPTO_FAILED"),
              "utf8"
            );
            const finalDatasetHash = sha256(localSelectedBytes);
            const seedCommitment = hashDomain("muse-recall-selection-seed-v2", seed);
            localReproductionKey = randomBytes(AES_KEY_BYTES);
            const selectedEnvelope = encryptEnvelope(localSelectedBytes, localReproductionKey);
            const selectedEnvelopeBytes = Buffer.from(
              canonicalJson(selectedEnvelope, "SEALED_CRYPTO_FAILED"),
              "utf8"
            );
            try {
              const provisionalTuple = {
                claimHash: ZERO_HASH,
                finalDatasetHash,
                metadataHash: sealed.metadataHash,
                poolCiphertextHash: sealed.poolCiphertextHash,
                poolEnvelopeHash: sealed.poolEnvelopeHash,
                poolHash: sealed.poolHash,
                seedCommitment,
                selectedEnvelopeHash: sha256(selectedEnvelopeBytes)
              };
              const claim = createClaim(
                SELECTION_CLAIM_SCHEMA,
                ledger.headHash,
                provisionalTuple
              );
              const tuple = { ...provisionalTuple, claimHash: claim.claimHash };
              await durableExclusiveFile(
                root,
                paths.selectionClaim(sealed.poolHash),
                Buffer.from(canonicalJson(claim, "SEALED_CLAIM_IO_FAILED"), "utf8"),
                "SEALED_CLAIM_IO_FAILED"
              );
              await durableExclusiveFile(
                root,
                paths.selectedEnvelope(sealed.poolHash, finalDatasetHash),
                selectedEnvelopeBytes,
                "SEALED_SEAL_IO_FAILED"
              );
              const consuming = makeEntry("consuming", tuple, ledger.entries.at(-1));
              await writeLedger(root, paths, [...ledger.entries, consuming]);
              const result = {
                claimHeadHash: claim.parentHeadHash,
                consumingHeadHash: consuming.entryHash,
                reproductionKey: localReproductionKey,
                selectedBytes: localSelectedBytes,
                tuple
              };
              localReproductionKey = undefined;
              localSelectedBytes = undefined;
              return result;
            } finally {
              selectedEnvelopeBytes.fill(0);
            }
          } finally {
            markerBytes?.fill(0);
            envelopeBytes?.fill(0);
            poolPlaintext?.fill(0);
            seed?.fill(0);
            localSelectedBytes?.fill(0);
            localReproductionKey?.fill(0);
          }
        });
        selectedBytes = lifecycle.selectedBytes;
        reproductionKey = lifecycle.reproductionKey;
        selectedPayload = JSON.parse(selectedBytes.toString("utf8"));
        let terminal;
        try {
          await consume(selectedPayload);
          callbackPassed = true;
        } catch {
          callbackFailed = true;
        } finally {
          terminal = await withMutationLock(root, paths, async () => {
            const ledger = await readLedger(root, paths);
            const current = ledger.latest.get(lifecycle.tuple.poolHash);
            if (current === undefined ||
                current.status !== "consuming" ||
                !sameSelectionTuple(current, lifecycle.tuple)) {
              throw failure("SEALED_LEDGER_INVALID");
            }
            const entry = makeEntry(
              callbackPassed ? "passed" : "burned",
              lifecycle.tuple,
              ledger.entries.at(-1)
            );
            await writeLedger(root, paths, [...ledger.entries, entry]);
            return entry;
          });
        }
        if (!callbackPassed || callbackFailed) {
          throw failure("SEALED_NETWORK_CALLBACK_FAILED");
        }

        const passedHandle = Object.freeze(function sealedPassedCapability() {
          throw failure("SEALED_REPRODUCTION_CLOSED");
        });
        passedCapabilities.set(passedHandle, {
          key: reproductionKey,
          tuple: Object.freeze({ ...lifecycle.tuple }),
          used: false
        });
        reproductionKey = undefined;
        return Object.freeze({
          ...aggregateCounts(),
          claimHeadHash: lifecycle.claimHeadHash,
          consumingHeadHash: lifecycle.consumingHeadHash,
          finalDatasetHash: lifecycle.tuple.finalDatasetHash,
          metadataHash: lifecycle.tuple.metadataHash,
          passedHandle,
          poolEnvelopeHash: lifecycle.tuple.poolEnvelopeHash,
          poolHash: lifecycle.tuple.poolHash,
          seedCommitment: lifecycle.tuple.seedCommitment,
          selectedEnvelopeHash: lifecycle.tuple.selectedEnvelopeHash,
          terminalHeadHash: terminal.entryHash
        });
      } finally {
        selectedBytes?.fill(0);
        reproductionKey?.fill(0);
        selectedPayload = undefined;
      }
      }).finally(() => {
        capability.key.fill(0);
      });
    };

    const reproducePassedOnce = (passedHandle, consume) => closedAsync(async () => {
      if ((typeof passedHandle !== "object" && typeof passedHandle !== "function") ||
          passedHandle === null ||
          typeof consume !== "function") {
        throw failure("SEALED_REPRODUCTION_CLOSED");
      }
      const capability = passedCapabilities.get(passedHandle);
      if (capability === undefined || capability.used) {
        throw failure("SEALED_REPRODUCTION_CLOSED");
      }
      // Reserve synchronously, before the first await, so two calls sharing the
      // same in-memory capability cannot both reach the filesystem.
      capability.used = true;
      let selectedBytes;
      let selectedPayload;
      let callbackPassed = false;
      let callbackFailed = false;
      let lifecycle;
      try {
        lifecycle = await withMutationLock(root, paths, async () => {
          const ledger = await readLedger(root, paths);
          const passed = ledger.latest.get(capability.tuple.poolHash);
          if (passed === undefined ||
              passed.status !== "passed" ||
              !sameSelectionTuple(passed, capability.tuple)) {
            throw failure("SEALED_REPRODUCTION_CLOSED");
          }
          let envelopeBytes;
          let plaintext;
          try {
            envelopeBytes = await readPrivateFile(
              root,
              paths.selectedEnvelope(passed.poolHash, passed.finalDatasetHash),
              false,
              "SEALED_SEAL_IO_FAILED"
            );
            if (sha256(envelopeBytes) !== passed.selectedEnvelopeHash) {
              throw failure("SEALED_CRYPTO_FAILED");
            }
            const envelope = parseCanonicalBytes(envelopeBytes, "SEALED_CRYPTO_FAILED");
            plaintext = decryptEnvelopeBytes(envelope, capability.key);
            if (sha256(plaintext) !== passed.finalDatasetHash) {
              throw failure("SEALED_CRYPTO_FAILED");
            }
            validateSelectedSolverViews(
              parseCanonicalBytes(plaintext, "SEALED_CRYPTO_FAILED"),
              passed.finalDatasetHash
            );
            const claim = createClaim(
              REPRODUCTION_CLAIM_SCHEMA,
              ledger.headHash,
              capability.tuple
            );
            await durableExclusiveFile(
              root,
              paths.reproductionClaim(passed.poolHash),
              Buffer.from(canonicalJson(claim, "SEALED_CLAIM_IO_FAILED"), "utf8"),
              "SEALED_CLAIM_IO_FAILED"
            );
            const consuming = makeEntry(
              "reproduction-consuming",
              capability.tuple,
              ledger.entries.at(-1)
            );
            await writeLedger(root, paths, [...ledger.entries, consuming]);
            const result = {
              claimHeadHash: claim.parentHeadHash,
              consumingHeadHash: consuming.entryHash,
              selectedBytes: plaintext
            };
            plaintext = undefined;
            return result;
          } finally {
            envelopeBytes?.fill(0);
            plaintext?.fill(0);
          }
        });
        selectedBytes = lifecycle.selectedBytes;
        selectedPayload = JSON.parse(selectedBytes.toString("utf8"));
        let terminal;
        try {
          await consume(selectedPayload);
          callbackPassed = true;
        } catch {
          callbackFailed = true;
        } finally {
          terminal = await withMutationLock(root, paths, async () => {
            const ledger = await readLedger(root, paths);
            const current = ledger.latest.get(capability.tuple.poolHash);
            if (current === undefined ||
                current.status !== "reproduction-consuming" ||
                !sameSelectionTuple(current, capability.tuple)) {
              throw failure("SEALED_LEDGER_INVALID");
            }
            const entry = makeEntry(
              callbackPassed ? "reproduced" : "burned",
              capability.tuple,
              ledger.entries.at(-1)
            );
            await writeLedger(root, paths, [...ledger.entries, entry]);
            return entry;
          });
        }
        if (!callbackPassed || callbackFailed) {
          throw failure("SEALED_NETWORK_CALLBACK_FAILED");
        }
        return Object.freeze({
          ...aggregateCounts(),
          claimHeadHash: lifecycle.claimHeadHash,
          consumingHeadHash: lifecycle.consumingHeadHash,
          finalDatasetHash: capability.tuple.finalDatasetHash,
          metadataHash: capability.tuple.metadataHash,
          poolEnvelopeHash: capability.tuple.poolEnvelopeHash,
          poolHash: capability.tuple.poolHash,
          selectedEnvelopeHash: capability.tuple.selectedEnvelopeHash,
          terminalHeadHash: terminal.entryHash
        });
      } finally {
        passedCapabilities.delete(passedHandle);
        capability.key.fill(0);
        selectedBytes?.fill(0);
        selectedPayload = undefined;
      }
    });

    const inspect = () => closedAsync(async () => {
      await assertSameRoot(root);
      return withMutationLock(root, paths, async () => {
        const ledger = await readLedger(root, paths);
        return Object.freeze({
          entries: ledger.entries.length,
          headHash: ledger.headHash,
          pools: Object.freeze([...ledger.latest.values()].map((entry) => Object.freeze({
            claimHash: entry.claimHash,
            finalDatasetHash: entry.finalDatasetHash,
            metadataHash: entry.metadataHash,
            poolEnvelopeHash: entry.poolEnvelopeHash,
            poolHash: entry.poolHash,
            status: entry.status,
            terminalHeadHash: entry.entryHash
          })))
        });
      });
    });

    const reconcile = () => closedAsync(async () => {
      await assertSameRoot(root);
      return withMutationLock(root, paths, async () => reconcileLocked(
        root,
        paths,
        (entry) => {
          const capability = openSealedCapabilities.get(entry.poolHash);
          return capability !== undefined &&
            !capability.used &&
            sameBaseTuple(capability.base, entry);
        }
      ));
    });

    return Object.freeze({
      inspect,
      reconcile,
      reproducePassedOnce,
      sealPoolOnce,
      selectFinal90Once
    });
  } catch (error) {
    throw closeError(error, "SEALED_ROOT_INVALID");
  }
}
