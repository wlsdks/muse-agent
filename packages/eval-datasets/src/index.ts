import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import {
  EVIDENCE_CLASS,
  FAMILIES,
  GENERATOR_VERSION,
  SYNTHETIC_PROVENANCE,
  SCHEMA_VERSION,
  TIERS,
  type CellCounts,
  type EvalRecord,
  type Family,
  type Tier,
  type TierManifest,
  type ValidationResult
} from "./eval-dataset-contract.js";
import { assertExactSyntheticRecord, cellKey, expectedCellCounts, generateRecord, sha256 } from "./eval-dataset-generate.js";

export * from "./eval-dataset-contract.js";
export { assertExactSyntheticRecord, cellKey, expectedCellCounts, generateRecord, SCALE_SEEDS } from "./eval-dataset-generate.js";

export async function resolveSafeEvalPath(rawPath: string, cwd = process.cwd()): Promise<string> {
  if (!rawPath || rawPath.includes("~") || rawPath.includes("\0")) throw new Error("Unsafe evaluation-data path");
  const workspace = resolve(cwd);
  const allowedRoot = resolve(workspace, ".muse-dev", "eval-data");
  const target = resolve(workspace, rawPath);
  if (target === allowedRoot || !target.startsWith(`${allowedRoot}${sep}`)) {
    throw new Error("Evaluation data must be below .muse-dev/eval-data/");
  }
  await assertNoExistingSymlink(target, workspace);
  return target;
}

async function writeJsonAtomic(path: string, value: unknown, mode: number): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode, flag: "wx" });
  await chmod(temp, mode);
  await rename(temp, path);
}

function newFamilyCounts(): Record<Family, number> {
  return Object.fromEntries(FAMILIES.map((family) => [family, 0])) as Record<Family, number>;
}

export async function generateTier(options: { tier: Tier; seed: number; out: string; cwd?: string; robustnessReplay?: boolean }): Promise<string> {
  const started = performance.now();
  const cwd = options.cwd ?? process.cwd();
  const out = await resolveSafeEvalPath(options.out, cwd);
  const mainLayout = basename(out) === String(options.tier) && basename(dirname(out)) === GENERATOR_VERSION;
  const replayLayout = basename(out) === String(options.tier) && basename(dirname(out)).startsWith("robustness-") && basename(dirname(dirname(out))) === GENERATOR_VERSION;
  if ((!options.robustnessReplay && !mainLayout) || (options.robustnessReplay && !replayLayout)) {
    throw new Error(options.robustnessReplay ? `Replay output must be .muse-dev/eval-data/${GENERATOR_VERSION}/robustness-<run>/${options.tier}` : `Output must be .muse-dev/eval-data/${GENERATOR_VERSION}/${options.tier}`);
  }
  if (await pathExists(out)) throw new Error(`Output already exists: ${relative(cwd, out)}`);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await chmod(dirname(out), 0o700);
  const tempDir = `${out}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(tempDir, { mode: 0o700 });
  const recordsPath = resolve(tempDir, "records.jsonl");
  const stream = createWriteStream(recordsPath, { encoding: "utf8", flags: "wx", mode: 0o600 });
  const digest = createHash("sha256");
  const cellCounts = expectedCellCounts(options.tier, options.seed);
  const familyCounts = newFamilyCounts();
  let bytes = 0;
  let peakRssBytes = process.memoryUsage().rss;
  try {
    for (let sequence = 0; sequence < options.tier; sequence += 1) {
      const record = generateRecord(options.tier, options.seed, sequence, { robustnessReplay: options.robustnessReplay });
      const line = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (lineBytes > 16_384) throw new Error(`Record ${record.recordId} exceeds 16 KiB`);
      bytes += lineBytes;
      if (bytes > 1_610_612_736) throw new Error("Tier exceeds the 1.5 GiB cap");
      digest.update(line, "utf8");
      familyCounts[record.family] += 1;
      if (!stream.write(line)) await new Promise<void>((resolveDrain) => stream.once("drain", resolveDrain));
      if (sequence % 4_096 === 0) peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      if (peakRssBytes > 536_870_912) throw new Error("Generation exceeded the 512 MiB RSS cap");
      if (performance.now() - started > 300_000) throw new Error("Generation exceeded the five-minute tier cap");
    }
    await new Promise<void>((resolveEnd, rejectEnd) => {
      stream.once("error", rejectEnd);
      stream.end(resolveEnd);
    });
    await chmod(recordsPath, 0o600);
    const wallTimeMs = Math.round(performance.now() - started);
    const manifest: TierManifest = {
      schemaVersion: SCHEMA_VERSION,
      generatorVersion: GENERATOR_VERSION,
      tier: options.tier,
      seed: options.seed,
      recordsFile: "records.jsonl",
      recordCount: options.tier,
      serializedCount: options.tier,
      bytes,
      corpusSha256: digest.digest("hex"),
      dataOrigin: "synthetic",
      organicEvidence: false,
      personalLearningEligible: false,
      humanOutcome: false,
      heldOut: false,
      evidenceClass: EVIDENCE_CLASS,
      robustnessReplay: options.robustnessReplay === true,
      cellCounts,
      familyCounts,
      peakRssBytes,
      wallTimeMs,
      recordSizeLimitBytes: 16_384,
      absoluteWriterByteCeiling: 1_610_612_736,
      peakRssLimitBytes: 536_870_912,
      tierTimeLimitMs: 300_000,
    };
    await writeJsonAtomic(resolve(tempDir, "manifest.json"), manifest, 0o600);
    await chmod(resolve(tempDir, "manifest.json"), 0o600);
    await rename(tempDir, out);
    return resolve(out, "manifest.json");
  } catch (error) {
    stream.destroy();
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} keys are not exact`);
}

const MANIFEST_KEYS = [
  "schemaVersion", "generatorVersion", "tier", "seed", "recordsFile", "recordCount", "serializedCount", "bytes", "corpusSha256",
  "dataOrigin", "organicEvidence", "personalLearningEligible", "humanOutcome", "heldOut", "evidenceClass", "robustnessReplay",
  "cellCounts", "familyCounts", "peakRssBytes", "wallTimeMs", "recordSizeLimitBytes", "absoluteWriterByteCeiling", "peakRssLimitBytes", "tierTimeLimitMs",
] as const;

export function assertManifest(value: unknown): asserts value is TierManifest {
  if (!value || typeof value !== "object") throw new Error("Manifest must be an object");
  assertExactKeys(value, MANIFEST_KEYS, "Manifest");
  const manifest = value as Partial<TierManifest>;
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.generatorVersion !== GENERATOR_VERSION || !TIERS.includes(manifest.tier as Tier) || !Number.isSafeInteger(manifest.seed)) throw new Error("Manifest identity is invalid");
  if (manifest.recordsFile !== "records.jsonl" || manifest.recordCount !== manifest.tier || manifest.serializedCount !== manifest.tier) throw new Error("Manifest count contract failed");
  if (manifest.dataOrigin !== "synthetic" || manifest.organicEvidence !== false || manifest.personalLearningEligible !== false || manifest.humanOutcome !== false || manifest.heldOut !== false || manifest.evidenceClass !== EVIDENCE_CLASS || typeof manifest.robustnessReplay !== "boolean") throw new Error("Manifest provenance contract failed");
  if (manifest.recordSizeLimitBytes !== 16_384 || manifest.absoluteWriterByteCeiling !== 1_610_612_736 || manifest.peakRssLimitBytes !== 536_870_912 || manifest.tierTimeLimitMs !== 300_000) throw new Error("Manifest resource contract failed");
  if (!Number.isSafeInteger(manifest.bytes) || (manifest.bytes as number) <= 0 || !Number.isFinite(manifest.peakRssBytes) || (manifest.peakRssBytes as number) <= 0 || !Number.isFinite(manifest.wallTimeMs) || (manifest.wallTimeMs as number) < 0) throw new Error("Manifest measured resources are invalid");
  if (typeof manifest.corpusSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.corpusSha256)) throw new Error("Manifest digest is invalid");
  const expectedCells = expectedCellCounts(manifest.tier as Tier, manifest.seed as number);
  if (JSON.stringify(manifest.cellCounts) !== JSON.stringify(expectedCells)) throw new Error("Manifest does not cover the balanced 96-cell matrix");
  const expectedFamilies = newFamilyCounts();
  for (const [key, count] of Object.entries(expectedCells)) expectedFamilies[key.split("|")[0] as Family] += count;
  if (JSON.stringify(manifest.familyCounts) !== JSON.stringify(expectedFamilies)) throw new Error("Manifest family counts are not exact");
  const values = Object.values(expectedCells);
  if (Math.max(...values) - Math.min(...values) > 1) throw new Error("Cell allocation differs by more than one");
}

export class CollisionDatabase {
  readonly database: DatabaseSync;
  readonly insert: ReturnType<DatabaseSync["prepare"]>;
  private transactionOpen = false;
  private pending = 0;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; CREATE TABLE seen(record_id TEXT UNIQUE NOT NULL, topic_hash TEXT UNIQUE NOT NULL, content_hash TEXT UNIQUE NOT NULL);");
    this.insert = this.database.prepare("INSERT INTO seen(record_id, topic_hash, content_hash) VALUES (?, ?, ?)");
  }

  add(record: EvalRecord): void {
    if (!this.transactionOpen) { this.database.exec("BEGIN"); this.transactionOpen = true; }
    try { this.insert.run(record.recordId, record.topicHash, record.contentHash); }
    catch { throw new Error(`Hash or record collision detected at ${record.recordId}`); }
    this.pending += 1;
    if (this.pending >= 10_000) this.flush();
  }

  flush(): void {
    if (this.transactionOpen) this.database.exec("COMMIT");
    this.transactionOpen = false;
    this.pending = 0;
  }

  close(): void { this.flush(); this.database.close(); }
}

export async function validateTier(manifestInput: string, options: { cwd?: string; collisionDatabase?: CollisionDatabase } = {}): Promise<ValidationResult> {
  const started = performance.now();
  const cwd = options.cwd ?? process.cwd();
  const manifestPath = await resolveSafeEvalPath(manifestInput, cwd);
  if (basename(manifestPath) !== "manifest.json") throw new Error("Expected a manifest.json path");
  const manifestMode = (await stat(manifestPath)).mode & 0o777;
  if (manifestMode !== 0o600) throw new Error(`Manifest mode must be 0600, got ${manifestMode.toString(8)}`);
  const manifestValue: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  assertManifest(manifestValue);
  const manifest = manifestValue;
  const tierDir = dirname(manifestPath);
  const mainLayout = basename(tierDir) === String(manifest.tier) && basename(dirname(tierDir)) === GENERATOR_VERSION;
  const replayLayout = basename(tierDir) === String(manifest.tier) && basename(dirname(tierDir)).startsWith("robustness-") && basename(dirname(dirname(tierDir))) === GENERATOR_VERSION;
  if ((!manifest.robustnessReplay && !mainLayout) || (manifest.robustnessReplay && !replayLayout)) throw new Error("Manifest is outside its canonical main or robustness-replay directory");
  const recordsPath = resolve(dirname(manifestPath), manifest.recordsFile);
  await assertNoExistingSymlink(recordsPath, resolve(cwd));
  const recordsMode = (await stat(recordsPath)).mode & 0o777;
  if (recordsMode !== 0o600) throw new Error(`Records mode must be 0600, got ${recordsMode.toString(8)}`);
  const ownedCollisionDir = options.collisionDatabase ? undefined : resolve(dirname(manifestPath), `.validate-run-${process.pid}-${Date.now()}`);
  if (ownedCollisionDir) await mkdir(ownedCollisionDir, { mode: 0o700 });
  const ownedCollisionDb = ownedCollisionDir ? resolve(ownedCollisionDir, "collisions.sqlite") : undefined;
  const collisionDatabase = options.collisionDatabase ?? new CollisionDatabase(ownedCollisionDb!);
  const digest = createHash("sha256");
  const sampleByCell = new Map<string, EvalRecord[]>();
  const counts: CellCounts = Object.fromEntries(Object.keys(manifest.cellCounts).map((key) => [key, 0]));
  let parsed = 0;
  let bytes = 0;
  let peakRssBytes = process.memoryUsage().rss;
  try {
    const lines = createInterface({ input: createReadStream(recordsPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) throw new Error(`Blank JSONL line at ${parsed + 1}`);
      const encodedLine = `${line}\n`;
      bytes += Buffer.byteLength(encodedLine, "utf8");
      digest.update(encodedLine, "utf8");
      const value: unknown = JSON.parse(line);
      assertExactSyntheticRecord(value);
      const record = value;
      if (record.sequence !== parsed || record.tier !== manifest.tier || record.seed !== manifest.seed || record.robustnessReplay !== manifest.robustnessReplay) throw new Error(`Record ordering, provenance, or manifest identity mismatch at ${parsed}`);
      collisionDatabase.add(record);
      const key = cellKey(record.family, record.locale, record.complexity);
      counts[key] = (counts[key] ?? 0) + 1;
      const cellSample = sampleByCell.get(key) ?? [];
      if (cellSample.length < 2) { cellSample.push(record); sampleByCell.set(key, cellSample); }
      parsed += 1;
      if (parsed % 4_096 === 0) peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      if (peakRssBytes > 536_870_912) throw new Error("Validation exceeded the 512 MiB RSS cap");
      if (performance.now() - started > 300_000) throw new Error("Validation exceeded the five-minute tier cap");
    }
    collisionDatabase.flush();
    if (parsed !== manifest.recordCount || parsed !== manifest.serializedCount) throw new Error(`Count mismatch: expected ${manifest.recordCount}, parsed ${parsed}`);
    if (bytes !== manifest.bytes || digest.digest("hex") !== manifest.corpusSha256) throw new Error("Corpus bytes or digest mismatch");
    if (JSON.stringify(counts) !== JSON.stringify(manifest.cellCounts)) throw new Error("Parsed 96-cell counts do not match the manifest");
    const sample = [...sampleByCell.values()].flat();
    if (sample.length !== Math.min(192, manifest.tier)) throw new Error(`Expected the stratified 2-per-cell sample, got ${sample.length}`);
    return {
      ...SYNTHETIC_PROVENANCE,
      robustnessReplay: manifest.robustnessReplay,
      manifest,
      generated: manifest.recordCount,
      serialized: manifest.serializedCount,
      parsedAndSchemaValidated: parsed,
      collisionCounts: { recordId: 0, topicHash: 0, contentHash: 0 },
      sample,
      peakRssBytes,
      wallTimeMs: Math.round(performance.now() - started),
    };
  } finally {
    if (!options.collisionDatabase) {
      collisionDatabase.close();
      await rm(ownedCollisionDir!, { recursive: true, force: true });
    }
  }
}

type OwnerEntry = { pathHash: string; kind: "directory" | "file" | "symlink"; mode: number; size: number; contentHash: string };

async function ownerEntries(root: string, current: string, entries: OwnerEntry[]): Promise<void> {
  const info = await lstat(current);
  const relativePath = relative(root, current) || ".";
  if (info.isSymbolicLink()) {
    entries.push({ pathHash: sha256(relativePath), kind: "symlink", mode: info.mode & 0o777, size: info.size, contentHash: "not-followed" });
    return;
  }
  if (info.isDirectory()) {
    entries.push({ pathHash: sha256(relativePath), kind: "directory", mode: info.mode & 0o777, size: info.size, contentHash: "directory" });
    const { readdir } = await import("node:fs/promises");
    for (const child of (await readdir(current)).sort()) await ownerEntries(root, resolve(current, child), entries);
    return;
  }
  entries.push({ pathHash: sha256(relativePath), kind: "file", mode: info.mode & 0o777, size: info.size, contentHash: sha256(await readFile(current)) });
}

export async function ownerMuseManifest(): Promise<{ exists: boolean; entryCount: number; digest: string }> {
  const root = resolve(homedir(), ".muse");
  if (!(await pathExists(root))) return { exists: false, entryCount: 0, digest: sha256("absent") };
  const entries: OwnerEntry[] = [];
  await ownerEntries(root, root, entries);
  return { exists: true, entryCount: entries.length, digest: sha256(JSON.stringify(entries)) };
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoExistingSymlink(path: string, stopAt: string): Promise<void> {
  let cursor = resolve(path);
  const floor = resolve(stopAt);
  const pending: string[] = [];
  while (cursor.startsWith(floor) && cursor !== dirname(cursor)) {
    pending.push(cursor);
    if (cursor === floor) break;
    cursor = dirname(cursor);
  }
  for (const entry of pending.reverse()) {
    if (await pathExists(entry)) {
      const info = await lstat(entry);
      if (info.isSymbolicLink()) throw new Error(`Symlink paths are forbidden: ${relative(process.cwd(), entry)}`);
    }
  }
}

