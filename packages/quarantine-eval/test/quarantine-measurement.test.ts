import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it, vi } from "vitest";

import { evaluateSyntheticQuarantineJson } from "../src/index.js";

const FROZEN = "2026-07-13T00:00:00.000Z";
const FIXTURE_URL = new URL("./fixtures/synthetic-quarantine-v1.json", import.meta.url);
const SOURCE_URL = new URL("../src/index.ts", import.meta.url);
const PACKAGE_URL = new URL("../package.json", import.meta.url);
const ROOT_TSCONFIG_URL = new URL("../../../tsconfig.json", import.meta.url);
const LOCK_URL = new URL("../../../pnpm-lock.yaml", import.meta.url);
const SYNTHETIC_RE = /^SYNTHETIC_[A-Z0-9_]{1,64}$/u;
const FORBIDDEN_PAYLOAD_RE = /(?:https?:\/\/|www\.|[\\/~@]|API[_-]?KEY|SECRET|PASSWORD|CREDENTIAL|TOKEN|PRIVATE[_-]?KEY|KEY)/iu;

let fixtureRawPromise: Promise<string> | undefined;

function fixtureRaw(): Promise<string> {
  fixtureRawPromise ??= readFile(FIXTURE_URL, "utf8");
  return fixtureRawPromise;
}

async function fixtureManifest(): Promise<Record<string, any>> {
  return JSON.parse(await fixtureRaw()) as Record<string, any>;
}

function resultForManifest(manifest: Record<string, any>, frozenAsOf = FROZEN) {
  return evaluateSyntheticQuarantineJson(JSON.stringify(manifest), frozenAsOf);
}

function canonical(value: any): string {
  if (value === null || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${canonical(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value: any): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function rehashArtifact(artifact: Record<string, any>): void {
  for (const source of artifact.sources) {
    source.hash = digest({ id: source.id, text: source.text });
  }
  artifact.sourceHashes = artifact.sources.map((source: Record<string, any>) => source.hash).sort();
  const projection = { ...artifact };
  delete projection.artifactHash;
  artifact.artifactHash = digest(projection);
}

function rehashManifest(manifest: Record<string, any>): void {
  for (const item of manifest.holdout.cases) {
    item.hash = digest({ id: item.id, prompt: item.prompt, expected: item.expected });
  }
  manifest.holdout.hashes = manifest.holdout.cases.map((item: Record<string, any>) => item.hash).sort();
  manifest.evaluator.descriptorHash = digest({
    id: "SYNTHETIC_EXACT_MATCH_V1",
    metricId: "synthetic-exact-match.v1",
    comparator: "decoded-string-exact"
  });
  rehashArtifact(manifest.baseline);
  rehashArtifact(manifest.candidate);
  manifest.rollbackPointer.baselineId = manifest.baseline.id;
  manifest.rollbackPointer.baselineArtifactHash = manifest.baseline.artifactHash;
  const rootProjection = { ...manifest };
  delete rootProjection.fixtureHash;
  manifest.fixtureHash = digest(rootProjection);
}

function errorsOf(result: ReturnType<typeof evaluateSyntheticQuarantineJson>) {
  return result.errors.map((item) => ({ code: item.code, path: item.path }));
}

function sourceTextToViolations(source: string): readonly string[] {
  const parsed = ts.createSourceFile("quarantine-eval-source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const imports: string[] = [];
  const clockRoots = new Set([
    "Date",
    "performance",
    "Temporal",
    "globalThis",
    "global"
  ]);
  const forbiddenNames = new Set([
    ...clockRoots,
    "eval",
    "Function",
    "process",
    "fetch",
    "WebSocket",
    "fs",
    "child_process"
  ]);
  const clockAliases = new Map<string, readonly string[]>();
  const requireAliases = new Set<string>();
  const jsonParseAliases = new Set<string>();
  const jsonRootAliases = new Set<string>();

  const unwrap = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
    }
    return current;
  };
  const normalizedChain = (node: ts.Expression): readonly string[] | undefined => {
    const current = unwrap(node);
    if (ts.isIdentifier(current)) {
      return [current.text];
    }
    if (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain(current)) {
      const base = normalizedChain(current.expression);
      return base ? [...base, current.name.text] : undefined;
    }
    if (ts.isElementAccessExpression(current) || ts.isElementAccessChain(current)) {
      const base = normalizedChain(current.expression);
      const argument = current.argumentExpression;
      const key = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? argument.text : undefined;
      if (!base) {
        return undefined;
      }
      return [...base, key ?? "[dynamic]"];
    }
    return undefined;
  };
  const chainText = (chain: readonly string[] | undefined): string => chain?.join(".") ?? "<unknown>";
  const chainRoot = (chain: readonly string[] | undefined): string | undefined => chain?.[0];
  const protectedChain = (chain: readonly string[] | undefined): boolean => {
    const root = chainRoot(chain);
    return root !== undefined && (clockRoots.has(root) || clockAliases.has(root));
  };
  const aliasRoot = (chain: readonly string[] | undefined): string | undefined => {
    const root = chainRoot(chain);
    return root !== undefined && clockAliases.has(root) ? root : undefined;
  };
  const requireChain = (chain: readonly string[] | undefined): boolean => {
    const root = chainRoot(chain);
    return root === "require" || (root !== undefined && requireAliases.has(root));
  };
  const jsonRootChain = (chain: readonly string[] | undefined): boolean => {
    const root = chainRoot(chain);
    return root === "JSON" || (root !== undefined && jsonRootAliases.has(root));
  };
  const jsonParseChain = (chain: readonly string[] | undefined): boolean => {
    const root = chainRoot(chain);
    return (root !== undefined && jsonParseAliases.has(root) && chain?.length === 1) || (jsonRootChain(chain) && chain?.[1] === "parse");
  };
  const staticPropertyName = (name: ts.PropertyName | undefined, fallback: string | undefined): string | undefined => {
    if (!name) {
      return fallback;
    }
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    if (ts.isComputedPropertyName(name)) {
      const expression = unwrap(name.expression);
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        return expression.text;
      }
    }
    return undefined;
  };
  const registerIdentifierAlias = (name: string, chain: readonly string[] | undefined): void => {
    if (!chain) {
      return;
    }
    if (protectedChain(chain)) {
      const inheritedAlias = aliasRoot(chain);
      if (inheritedAlias) {
        violations.push(`clock-alias-use:${inheritedAlias}`);
      }
      clockAliases.set(name, chain);
      violations.push(`clock-alias:${name}=${chainText(chain)}`);
    }
    if (requireChain(chain)) {
      requireAliases.add(name);
      violations.push(`require-alias:${name}`);
    }
    if (jsonRootChain(chain) && chain.length === 1) {
      jsonRootAliases.add(name);
      violations.push(`json-root-alias:${name}`);
    }
    if (jsonParseChain(chain)) {
      jsonParseAliases.add(name);
      violations.push(`json-parse-alias:${name}`);
    }
  };
  const bindPatternFromChain = (name: ts.BindingName, chain: readonly string[] | undefined): void => {
    if (!chain) {
      return;
    }
    if (ts.isIdentifier(name)) {
      registerIdentifierAlias(name.text, chain);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        const fallback = ts.isIdentifier(element.name) ? element.name.text : undefined;
        const property = staticPropertyName(element.propertyName, fallback);
        if (property === undefined) {
          violations.push(`clock-destructure-dynamic:${chainText(chain)}`);
          continue;
        }
        bindPatternFromChain(element.name, [...chain, property]);
      }
      return;
    }
    for (let index = 0; index < name.elements.length; index += 1) {
      const element = name.elements[index];
      if (!element || ts.isOmittedExpression(element)) {
        continue;
      }
      bindPatternFromChain(element.name, [...chain, String(index)]);
    }
  };
  const bindPattern = (name: ts.BindingName, initializer: ts.Expression): void => {
    const current = unwrap(initializer);
    if (ts.isArrayBindingPattern(name) && ts.isArrayLiteralExpression(current)) {
      for (let index = 0; index < name.elements.length; index += 1) {
        const element = name.elements[index];
        const input = current.elements[index];
        if (!element || ts.isOmittedExpression(element) || !input || ts.isOmittedExpression(input) || ts.isSpreadElement(input)) {
          continue;
        }
        bindPattern(element.name, input);
      }
      return;
    }
    bindPatternFromChain(name, normalizedChain(current));
  };
  const bindAssignmentTargetFromChain = (target: ts.Expression, chain: readonly string[] | undefined): void => {
    const current = unwrap(target);
    if (!chain) {
      return;
    }
    if (ts.isIdentifier(current)) {
      registerIdentifierAlias(current.text, chain);
      return;
    }
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (!ts.isPropertyAssignment(property)) {
          violations.push(`clock-destructure-dynamic:${chainText(chain)}`);
          continue;
        }
        const key = staticPropertyName(property.name, undefined);
        if (key === undefined) {
          violations.push(`clock-destructure-dynamic:${chainText(chain)}`);
          continue;
        }
        bindAssignmentTargetFromChain(property.initializer, [...chain, key]);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (let index = 0; index < current.elements.length; index += 1) {
        const element = current.elements[index];
        if (!element || ts.isOmittedExpression(element) || ts.isSpreadElement(element)) {
          continue;
        }
        bindAssignmentTargetFromChain(element, [...chain, String(index)]);
      }
    }
  };
  const bindAssignmentTarget = (target: ts.Expression, initializer: ts.Expression): void => {
    const currentInitializer = unwrap(initializer);
    const currentTarget = unwrap(target);
    if (ts.isArrayLiteralExpression(currentTarget) && ts.isArrayLiteralExpression(currentInitializer)) {
      for (let index = 0; index < currentTarget.elements.length; index += 1) {
        const targetElement = currentTarget.elements[index];
        const input = currentInitializer.elements[index];
        if (!targetElement || !input || ts.isOmittedExpression(targetElement) || ts.isOmittedExpression(input) || ts.isSpreadElement(input)) {
          continue;
        }
        bindAssignmentTarget(targetElement, input);
      }
      return;
    }
    bindAssignmentTargetFromChain(currentTarget, normalizedChain(currentInitializer));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node)) {
      violations.push("import-equals");
    }
    if (ts.isIdentifier(node) && forbiddenNames.has(node.text)) {
      violations.push(`forbidden:${node.text}`);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      bindPattern(node.name, node.initializer);
    }
    if (ts.isParameter(node) && node.initializer) {
      bindPattern(node.name, node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const assignedAlias = aliasRoot(normalizedChain(node.left));
      if (assignedAlias) {
        violations.push(`clock-alias-use:${assignedAlias}`);
      }
      bindAssignmentTarget(node.left, node.right);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        violations.push("dynamic-import");
      }
      const callee = normalizedChain(node.expression);
      if (requireChain(callee)) {
        violations.push("require");
      }
      if (jsonParseChain(callee)) {
        violations.push("json-parse");
      }
      const calledAlias = aliasRoot(callee);
      if (calledAlias) {
        violations.push(`clock-alias-call:${calledAlias}`);
        violations.push(`clock-alias-use:${calledAlias}`);
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node) || ts.isElementAccessExpression(node) || ts.isElementAccessChain(node)) {
      const chain = normalizedChain(node);
      if (protectedChain(chain)) {
        violations.push(`clock-chain:${chainText(chain)}`);
        const alias = aliasRoot(chain);
        if (alias) {
          violations.push(`clock-alias-use:${alias}`);
        }
        if (chain?.includes("[dynamic]")) {
          violations.push(`clock-unknown-computed:${chainText(chain)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  const importSet = [...new Set(imports)].sort();
  if (canonical(importSet) !== canonical(["node:crypto"])) {
    violations.push(`imports:${importSet.join(",")}`);
  }
  return violations;
}

type TemporalTrapMode = "absent" | "nonconfigurable" | "trapped";

interface TemporalImportTrap {
  readonly mode: TemporalTrapMode;
  readonly nowMode: TemporalTrapMode;
  readonly nowReads: () => number;
  readonly rootReads: () => number;
  restore(): void;
}

interface TemporalInvocationTrap {
  readonly mode: "absent" | "trapped";
  readonly reads: () => number;
  restore(): void;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function inheritedDescriptor(target: object, key: string): PropertyDescriptor | undefined {
  let current: object | null = target;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return descriptor;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function canReplaceProperty(target: object, key: string): boolean {
  const own = Object.getOwnPropertyDescriptor(target, key);
  if (own) {
    return own.configurable === true;
  }
  const inherited = inheritedDescriptor(Object.getPrototypeOf(target) ?? {}, key);
  return (inherited?.configurable ?? true) && Object.isExtensible(target);
}

function installThrowingGetter(target: object, key: string, onRead: () => void): () => void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: original?.enumerable ?? false,
    get: () => {
      onRead();
      throw new Error(`${key} access is forbidden during quarantine evaluation`);
    }
  });
  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    if (original) {
      Object.defineProperty(target, key, original);
    } else {
      Reflect.deleteProperty(target, key);
    }
  };
}

function installTemporalImportTrap(host: object): TemporalImportTrap {
  const temporal = Reflect.get(host, "Temporal");
  if (temporal === undefined) {
    return {
      mode: "absent",
      nowMode: "absent",
      nowReads: () => 0,
      rootReads: () => 0,
      restore: () => undefined
    };
  }
  if (!canReplaceProperty(host, "Temporal")) {
    return {
      mode: "nonconfigurable",
      nowMode: "nonconfigurable",
      nowReads: () => 0,
      rootReads: () => 0,
      restore: () => undefined
    };
  }

  let rootReads = 0;
  let nowReads = 0;
  const restoreRoot = installThrowingGetter(host, "Temporal", () => {
    rootReads += 1;
  });
  let nowMode: TemporalTrapMode = "absent";
  let restoreNow = () => undefined;
  if (isObjectLike(temporal)) {
    if (canReplaceProperty(temporal, "Now")) {
      nowMode = "trapped";
      restoreNow = installThrowingGetter(temporal, "Now", () => {
        nowReads += 1;
      });
    } else {
      nowMode = "nonconfigurable";
    }
  }
  let restored = false;
  return {
    mode: "trapped",
    nowMode,
    nowReads: () => nowReads,
    rootReads: () => rootReads,
    restore: () => {
      if (restored) {
        return;
      }
      restored = true;
      restoreNow();
      restoreRoot();
    }
  };
}

function installTemporalInvocationTrap(host: object): TemporalInvocationTrap {
  const temporal = Reflect.get(host, "Temporal");
  if (temporal === undefined) {
    return { mode: "absent", reads: () => 0, restore: () => undefined };
  }
  if (!isObjectLike(temporal) || !canReplaceProperty(temporal, "Now")) {
    throw new Error("Temporal.Now trap configuration unavailable");
  }
  let reads = 0;
  const restore = installThrowingGetter(temporal, "Now", () => {
    reads += 1;
  });
  return { mode: "trapped", reads: () => reads, restore };
}

function collectPayloads(manifest: Record<string, any>): string[] {
  const payloads: string[] = [manifest.baseline.id, manifest.candidate.id];
  for (const artifact of [manifest.baseline, manifest.candidate]) {
    for (const source of artifact.sources) {
      payloads.push(source.id, source.text);
    }
    for (const output of artifact.outputs) {
      payloads.push(output.caseId, output.output);
    }
  }
  for (const item of manifest.holdout.cases) {
    payloads.push(item.id, item.prompt, item.expected);
  }
  return payloads;
}

describe("synthetic quarantine measurement kernel", () => {
  it("returns a deterministic quarantined result for the single anchored synthetic fixture", async () => {
    const raw = await fixtureRaw();
    const first = evaluateSyntheticQuarantineJson(raw, FROZEN);
    const second = evaluateSyntheticQuarantineJson(raw, FROZEN);
    const third = evaluateSyntheticQuarantineJson(raw, FROZEN);

    expect(first).toEqual({
      schemaVersion: "muse.synthetic-quarantine-result.v1",
      status: "QUARANTINED",
      promotionState: "PROMOTION_DISABLED",
      fixtureId: "SYNTHETIC_QUARANTINE_FIXTURE_V1",
      fixtureHash: "d8e652e1358054c79b004499e0020a35d5f065905cae7ec122caa48150f027d0",
      scorecard: {
        metricId: "synthetic-exact-match.v1",
        caseCount: 2,
        baselineScore: 1,
        candidateScore: 0.5,
        delta: -0.5
      },
      rollback: {
        baselineId: "SYNTHETIC_BASELINE_V1",
        baselineArtifactHash: "17e8d626c8b649b176f6a0ff7c9a392b68936ffe9b2bf66cd47c3c1b72e5fd96"
      },
      errors: []
    });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(Object.keys(first)).toEqual([
      "schemaVersion",
      "status",
      "promotionState",
      "fixtureId",
      "fixtureHash",
      "scorecard",
      "rollback",
      "errors"
    ]);
  });

  it("accepts raw JSON only and preserves raw parser error ownership", async () => {
    const raw = await fixtureRaw();
    for (const value of [null, 1, Buffer.from(raw), {}, []]) {
      expect(errorsOf(evaluateSyntheticQuarantineJson(value, FROZEN))).toEqual([{ code: "INVALID_INPUT", path: "" }]);
    }
    expect(errorsOf(evaluateSyntheticQuarantineJson("[]", FROZEN))).toEqual([{ code: "INVALID_INPUT", path: "" }]);
    expect(errorsOf(evaluateSyntheticQuarantineJson("true", FROZEN))).toEqual([{ code: "INVALID_INPUT", path: "" }]);
    expect(errorsOf(evaluateSyntheticQuarantineJson("{", FROZEN))).toEqual([{ code: "INVALID_JSON", path: "" }]);
    expect(errorsOf(evaluateSyntheticQuarantineJson(raw, "2026-07-13T00:00:00Z"))).toEqual([{ code: "INVALID_INPUT", path: "" }]);
    expect(errorsOf(evaluateSyntheticQuarantineJson(raw, "2026-02-30T00:00:00.000Z"))).toEqual([{ code: "INVALID_INPUT", path: "" }]);
  });

  it("detects duplicate fields at every depth before structural validation", () => {
    expect(errorsOf(evaluateSyntheticQuarantineJson('{"schemaVersion":"x","schemaVersion":"y"}', FROZEN))).toEqual([
      { code: "DUPLICATE_FIELD", path: "/schemaVersion" }
    ]);
    expect(errorsOf(evaluateSyntheticQuarantineJson('{"baseline":{"sources":[{"id":"SYNTHETIC_A","id":"SYNTHETIC_B"}]}}', FROZEN))).toEqual([
      { code: "DUPLICATE_FIELD", path: "/baseline/sources/0/id" }
    ]);
    expect(errorsOf(evaluateSyntheticQuarantineJson('{"a/b":1,"a/b":2,"a~b":1,"a~b":2}', FROZEN))).toEqual([
      { code: "DUPLICATE_FIELD", path: "/a~1b" },
      { code: "DUPLICATE_FIELD", path: "/a~0b" }
    ]);
    expect(errorsOf(evaluateSyntheticQuarantineJson('{"x":"\\uD800"}', FROZEN))).toEqual([{ code: "INVALID_JSON", path: "" }]);
  });

  it("treats prototype-shaped keys as ordinary unknown fields", async () => {
    const raw = await fixtureRaw();
    const rootPrototype = raw.replace("{", '{"__proto__":"SYNTHETIC_EXTRA",');
    expect(errorsOf(evaluateSyntheticQuarantineJson(rootPrototype, FROZEN))).toEqual([{ code: "UNEXPECTED_FIELD", path: "/__proto__" }]);
    const nestedPrototype = raw.replace('"baseline": {', '"baseline": {"__proto__":"SYNTHETIC_EXTRA",');
    expect(errorsOf(evaluateSyntheticQuarantineJson(nestedPrototype, FROZEN))).toEqual([{ code: "UNEXPECTED_FIELD", path: "/baseline/__proto__" }]);
  });

  it("applies the parser resource caps deterministically", () => {
    const atRawCap = `${" ".repeat(65_534)}{}`;
    expect(Buffer.byteLength(atRawCap, "utf8")).toBe(65_536);
    expect(errorsOf(evaluateSyntheticQuarantineJson(atRawCap, FROZEN))[0]).not.toEqual({ code: "INVALID_INPUT", path: "" });
    expect(errorsOf(evaluateSyntheticQuarantineJson(`${atRawCap} `, FROZEN))).toEqual([{ code: "INVALID_INPUT", path: "" }]);

    const objectAtCap = `{${Array.from({ length: 64 }, (_, index) => `"x${index}":null`).join(",")}}`;
    const objectOverCap = `{${Array.from({ length: 65 }, (_, index) => `"x${index}":null`).join(",")}}`;
    expect(errorsOf(evaluateSyntheticQuarantineJson(objectAtCap, FROZEN)).some((item) => item.code === "VALUE_INVALID")).toBe(false);
    expect(errorsOf(evaluateSyntheticQuarantineJson(objectOverCap, FROZEN))).toEqual([{ code: "VALUE_INVALID", path: "" }]);

    const arrayAtCap = `[${Array.from({ length: 128 }, () => "null").join(",")}]`;
    const arrayOverCap = `[${Array.from({ length: 129 }, () => "null").join(",")}]`;
    expect(errorsOf(evaluateSyntheticQuarantineJson(arrayAtCap, FROZEN))).toEqual([{ code: "INVALID_INPUT", path: "" }]);
    expect(errorsOf(evaluateSyntheticQuarantineJson(arrayOverCap, FROZEN))).toEqual([{ code: "VALUE_INVALID", path: "" }]);

    const nestedAtCap = `${"[".repeat(31)}{}${"]".repeat(31)}`;
    const nestedOverCap = `${"[".repeat(32)}{}${"]".repeat(32)}`;
    expect(errorsOf(evaluateSyntheticQuarantineJson(nestedAtCap, FROZEN))).toEqual([{ code: "INVALID_INPUT", path: "" }]);
    expect(errorsOf(evaluateSyntheticQuarantineJson(nestedOverCap, FROZEN))).toEqual([
      { code: "VALUE_INVALID", path: "/0".repeat(32) }
    ]);

    const keyAtCap = `{"${"A".repeat(64)}":null}`;
    const keyOverCap = `{"${"A".repeat(65)}":null}`;
    expect(errorsOf(evaluateSyntheticQuarantineJson(keyAtCap, FROZEN)).some((item) => item.code === "VALUE_INVALID")).toBe(false);
    expect(errorsOf(evaluateSyntheticQuarantineJson(keyOverCap, FROZEN))).toEqual([{ code: "VALUE_INVALID", path: "" }]);

    const stringAtCap = `"${"A".repeat(256)}"`;
    const stringOverCap = `"${"A".repeat(257)}"`;
    expect(errorsOf(evaluateSyntheticQuarantineJson(stringAtCap, FROZEN))).toEqual([{ code: "INVALID_INPUT", path: "" }]);
    expect(errorsOf(evaluateSyntheticQuarantineJson(stringOverCap, FROZEN))).toEqual([{ code: "VALUE_INVALID", path: "" }]);

    const numberAtCap = `{"x":${"1".repeat(64)}}`;
    const numberOverCap = `{"x":${"1".repeat(65)}}`;
    expect(errorsOf(evaluateSyntheticQuarantineJson(numberAtCap, FROZEN)).some((item) => item.code === "VALUE_INVALID")).toBe(false);
    expect(errorsOf(evaluateSyntheticQuarantineJson(numberOverCap, FROZEN))).toEqual([{ code: "VALUE_INVALID", path: "/x" }]);

    const nodeArray = (length: number) => `[${Array.from({ length }, () => "null").join(",")}]`;
    const nodeAtCap = `{${Array.from({ length: 16 }, (_, index) => `"x${index}":${nodeArray(index === 15 ? 111 : 128)}`).join(",")}}`;
    const nodeOverCap = `{${Array.from({ length: 16 }, (_, index) => `"x${index}":${nodeArray(index === 15 ? 112 : 128)}`).join(",")}}`;
    expect(errorsOf(evaluateSyntheticQuarantineJson(nodeAtCap, FROZEN)).some((item) => item.code === "VALUE_INVALID")).toBe(false);
    expect(errorsOf(evaluateSyntheticQuarantineJson(nodeOverCap, FROZEN))).toEqual([{ code: "VALUE_INVALID", path: "/x15/111" }]);
  });

  it("keeps structural errors isolated from semantic/root checks", async () => {
    const missing = await fixtureManifest();
    delete missing.fixtureId;
    expect(errorsOf(resultForManifest(missing))).toEqual([{ code: "REQUIRED_FIELD_MISSING", path: "/fixtureId" }]);

    const malformed = await fixtureManifest();
    malformed.candidate.promotionRequested = "false";
    malformed.candidate.extra = "SYNTHETIC_EXTRA";
    expect(errorsOf(resultForManifest(malformed))).toEqual([
      { code: "UNEXPECTED_FIELD", path: "/candidate/extra" },
      { code: "FIELD_TYPE_INVALID", path: "/candidate/promotionRequested" }
    ]);
  });

  it("enforces semantic subphases and appends the immutable root anchor last", async () => {
    const manifest = await fixtureManifest();
    manifest.candidate.writeTargets = ["policy"];
    manifest.candidate.promotionRequested = true;
    rehashManifest(manifest);
    expect(errorsOf(resultForManifest(manifest))).toEqual([
      { code: "PROMOTION_REQUEST_FORBIDDEN", path: "/candidate/promotionRequested" },
      { code: "WRITE_TARGET_FORBIDDEN", path: "/candidate/writeTargets/0" },
      { code: "FIXTURE_HASH_MISMATCH", path: "" }
    ]);

    const expired = await fixtureManifest();
    expired.expiresAt = FROZEN;
    rehashManifest(expired);
    expect(errorsOf(resultForManifest(expired))).toEqual([
      { code: "EXPIRED", path: "/expiresAt" },
      { code: "FIXTURE_HASH_MISMATCH", path: "" }
    ]);

    const providerDrift = await fixtureManifest();
    providerDrift.candidate.provider.modelId = "SYNTHETIC_OTHER_MODEL_V1";
    rehashManifest(providerDrift);
    expect(errorsOf(resultForManifest(providerDrift))).toEqual([
      { code: "PROVIDER_TUPLE_MISMATCH", path: "/candidate/provider" },
      { code: "PROVIDER_TUPLE_INVALID", path: "/candidate/provider/modelId" },
      { code: "FIXTURE_HASH_MISMATCH", path: "" }
    ]);
  });

  it("rejects a fully rehashed semantic forgery solely at the trusted root literal", async () => {
    const forged = await fixtureManifest();
    forged.candidate.outputs[1].output = "SYNTHETIC_FORGED_OUTPUT_B";
    rehashManifest(forged);
    expect(errorsOf(resultForManifest(forged))).toEqual([{ code: "FIXTURE_HASH_MISMATCH", path: "" }]);
  });

  it("keeps canonical raw whitespace and object key order semantically equivalent", async () => {
    const manifest = await fixtureManifest();
    const reversed = Object.fromEntries(Object.entries(manifest).reverse());
    const first = evaluateSyntheticQuarantineJson(`\n  ${JSON.stringify(reversed, null, 2)}\n`, FROZEN);
    const second = evaluateSyntheticQuarantineJson(await fixtureRaw(), FROZEN);
    expect(first).toEqual(second);
  });

  it("keeps the seven-file package boundary and its synthetic fixture contract explicit", async () => {
    const [packageText, rootTsconfigText, lockText, raw, fixtureFiles] = await Promise.all([
      readFile(PACKAGE_URL, "utf8"),
      readFile(ROOT_TSCONFIG_URL, "utf8"),
      readFile(LOCK_URL, "utf8"),
      fixtureRaw(),
      readdir(new URL("./fixtures/", import.meta.url))
    ]);
    const packageManifest = JSON.parse(packageText) as Record<string, any>;
    const rootTsconfig = JSON.parse(rootTsconfigText) as { references: readonly { path: string }[] };
    const manifest = JSON.parse(raw) as Record<string, any>;
    expect(fixtureFiles).toEqual(["synthetic-quarantine-v1.json"]);
    expect(packageManifest).toMatchObject({
      name: "@muse/quarantine-eval",
      version: "0.0.0",
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts"
    });
    expect(packageManifest.scripts).toEqual({ build: "tsc -b", test: "vitest run", typecheck: "tsc -p tsconfig.json --noEmit" });
    expect(Object.hasOwn(packageManifest, "dependencies")).toBe(false);
    expect(Object.hasOwn(packageManifest, "devDependencies")).toBe(false);
    expect(rootTsconfig.references.filter((entry) => entry.path === "./packages/quarantine-eval")).toHaveLength(1);
    expect(lockText.match(/^ {2}packages\/quarantine-eval: \{\}$/gmu)).toHaveLength(1);
    expect(raw).not.toMatch(/Date|performance|Temporal|globalThis|global|Date\.now|performance\.now|Temporal\.Now/u);
    for (const payload of collectPayloads(manifest)) {
      expect(payload).toMatch(SYNTHETIC_RE);
      expect(payload).not.toMatch(FORBIDDEN_PAYLOAD_RE);
    }
  });

  it("uses an actual-source AST fence for imports, parsing, clock roots, aliases, and ambient effects", async () => {
    const actualSource = await readFile(SOURCE_URL, "utf8");
    expect(sourceTextToViolations(actualSource)).toEqual([]);
    const helpers: readonly { readonly markers: readonly string[]; readonly source: string }[] = [
      { source: "const value = Date;", markers: ["forbidden:Date"] },
      { source: "const value = Date.now;", markers: ["clock-chain:Date.now"] },
      { source: "const value = Date['now'];", markers: ["clock-chain:Date.now"] },
      { source: "const value = Date?.now;", markers: ["clock-chain:Date.now"] },
      { source: "const value = performance;", markers: ["forbidden:performance"] },
      { source: "const value = performance.now;", markers: ["clock-chain:performance.now"] },
      { source: "const value = performance['now'];", markers: ["clock-chain:performance.now"] },
      { source: "const value = performance?.now;", markers: ["clock-chain:performance.now"] },
      { source: "const value = Temporal;", markers: ["forbidden:Temporal"] },
      { source: "const value = Temporal.Now;", markers: ["clock-chain:Temporal.Now"] },
      { source: "const value = Temporal['Now'];", markers: ["clock-chain:Temporal.Now"] },
      { source: "const value = Temporal?.Now;", markers: ["clock-chain:Temporal.Now"] },
      { source: "const value = globalThis;", markers: ["forbidden:globalThis"] },
      { source: "const value = globalThis.Date.now;", markers: ["clock-chain:globalThis.Date.now"] },
      { source: "const value = globalThis['Date']['now'];", markers: ["clock-chain:globalThis.Date.now"] },
      { source: "const value = globalThis?.Date?.now;", markers: ["clock-chain:globalThis.Date.now"] },
      { source: "const value = global;", markers: ["forbidden:global"] },
      { source: "const value = global.performance.now;", markers: ["clock-chain:global.performance.now"] },
      { source: "const value = global['performance']['now'];", markers: ["clock-chain:global.performance.now"] },
      { source: "const value = global?.performance?.now;", markers: ["clock-chain:global.performance.now"] },
      { source: "const value = globalThis.performance.now;", markers: ["clock-chain:globalThis.performance.now"] },
      { source: "const value = globalThis['performance']['now'];", markers: ["clock-chain:globalThis.performance.now"] },
      { source: "const value = globalThis?.performance?.now;", markers: ["clock-chain:globalThis.performance.now"] },
      { source: "const value = global.Temporal.Now;", markers: ["clock-chain:global.Temporal.Now"] },
      { source: "const value = global['Temporal']['Now'];", markers: ["clock-chain:global.Temporal.Now"] },
      { source: "const value = global?.Temporal?.Now;", markers: ["clock-chain:global.Temporal.Now"] },
      { source: "const value = globalThis.Temporal.Now;", markers: ["clock-chain:globalThis.Temporal.Now"] },
      { source: "const value = globalThis['Temporal']['Now'];", markers: ["clock-chain:globalThis.Temporal.Now"] },
      { source: "const value = globalThis?.Temporal?.Now;", markers: ["clock-chain:globalThis.Temporal.Now"] },
      { source: "const g = globalThis; g['Date'];", markers: ["clock-alias:g=globalThis", "clock-alias-use:g"] },
      { source: "const g = globalThis; const key = 'Date'; g[key];", markers: ["clock-alias:g=globalThis", "clock-unknown-computed:g.[dynamic]"] },
      { source: "function read(clock = Date) { return clock.now; }", markers: ["clock-alias:clock=Date", "clock-alias-use:clock"] },
      { source: "function read({ now: clock } = performance) { return clock(); }", markers: ["clock-alias:clock=performance.now", "clock-alias-call:clock"] },
      { source: "function read([clock] = [Date]) { return clock.now; }", markers: ["clock-alias:clock=Date", "clock-alias-use:clock"] },
      { source: "const { Date: d } = globalThis; d.now;", markers: ["clock-alias:d=globalThis.Date", "clock-alias-use:d"] },
      { source: "const root = globalThis; const { Date: d } = root; d.now;", markers: ["clock-alias-use:root", "clock-alias:d=root.Date"] },
      { source: "const [d] = [Date]; d.now;", markers: ["clock-alias:d=Date", "clock-alias-use:d"] },
      { source: "let d; d = Date; d.now;", markers: ["clock-alias:d=Date", "clock-alias-use:d"] },
      { source: "let clock; ({ now: clock } = performance); clock();", markers: ["clock-alias:clock=performance.now", "clock-alias-call:clock"] },
      { source: "let clock; [clock] = [Date]; clock.now;", markers: ["clock-alias:clock=Date", "clock-alias-use:clock"] },
      { source: "const key = 'Date'; const value = globalThis[key];", markers: ["clock-unknown-computed:globalThis.[dynamic]"] },
      { source: "require('node:fs');", markers: ["require"] },
      { source: "const load = require; load('node:fs');", markers: ["require-alias:load", "require"] },
      { source: "let load; load = require; load('node:fs');", markers: ["require-alias:load", "require"] },
      { source: "import fs = require('node:fs');", markers: ["import-equals"] },
      { source: "JSON.parse('{}');", markers: ["json-parse"] },
      { source: "const parse = JSON.parse; parse('{}');", markers: ["json-parse-alias:parse", "json-parse"] },
      { source: "const J = JSON; J.parse('{}');", markers: ["json-root-alias:J", "json-parse"] },
      { source: "let parse; parse = JSON.parse; parse('{}');", markers: ["json-parse-alias:parse", "json-parse"] },
      { source: "import('node:fs');", markers: ["dynamic-import"] },
      { source: "eval('x');", markers: ["forbidden:eval"] },
      { source: "Function('return 1');", markers: ["forbidden:Function"] },
      { source: "process.cwd();", markers: ["forbidden:process"] },
      { source: "fetch('https://example.test');", markers: ["forbidden:fetch"] },
      { source: "new WebSocket('wss://example.test');", markers: ["forbidden:WebSocket"] },
      { source: "fs.writeFileSync('x', 'y');", markers: ["forbidden:fs"] },
      { source: "child_process.spawn('x');", markers: ["forbidden:child_process"] }
    ];
    for (const helper of helpers) {
      expect(sourceTextToViolations(helper.source)).toEqual(expect.arrayContaining(helper.markers));
    }
    expect(sourceTextToViolations("import { createHash } from 'node:crypto'; const safe = createHash('sha256');")).toEqual([]);
  });

  it("makes Temporal trap availability explicit instead of silently skipping a partial dynamic fence", () => {
    const absent = installTemporalImportTrap({});
    expect(absent.mode).toBe("absent");
    expect(absent.nowMode).toBe("absent");
    absent.restore();

    const configurableTemporal = {};
    Object.defineProperty(configurableTemporal, "Now", { configurable: true, value: {} });
    const configurableHost = {};
    Object.defineProperty(configurableHost, "Temporal", { configurable: true, value: configurableTemporal });
    const preImport = installTemporalImportTrap(configurableHost);
    expect(preImport.mode).toBe("trapped");
    expect(preImport.nowMode).toBe("trapped");
    expect(() => Reflect.get(configurableHost, "Temporal")).toThrow(/forbidden/u);
    expect(() => Reflect.get(configurableTemporal, "Now")).toThrow(/forbidden/u);
    expect(preImport.rootReads()).toBe(1);
    expect(preImport.nowReads()).toBe(1);
    preImport.restore();
    expect(Reflect.get(configurableHost, "Temporal")).toBe(configurableTemporal);

    const invocation = installTemporalInvocationTrap(configurableHost);
    expect(invocation.mode).toBe("trapped");
    expect(() => Reflect.get(configurableTemporal, "Now")).toThrow(/forbidden/u);
    expect(invocation.reads()).toBe(1);
    invocation.restore();

    const lockedTemporal = {};
    Object.defineProperty(lockedTemporal, "Now", { configurable: false, value: {} });
    const lockedHost = {};
    Object.defineProperty(lockedHost, "Temporal", { configurable: false, value: lockedTemporal });
    const noImportClaim = installTemporalImportTrap(lockedHost);
    expect(noImportClaim.mode).toBe("nonconfigurable");
    expect(noImportClaim.nowMode).toBe("nonconfigurable");
    expect(() => installTemporalInvocationTrap(lockedHost)).toThrow(/configuration unavailable/u);
  });

  it("does not read, write, spawn, fetch, use a clock, or alter an empty HOME during isolated invocation", async () => {
    const raw = await fixtureRaw();
    const emptyHome = await mkdtemp(join(tmpdir(), "muse-quarantine-empty-home-"));
    const before = await readdir(emptyHome);
    const sideEffect = vi.fn(() => {
      throw new Error("side effect is forbidden");
    });
    vi.stubEnv("HOME", emptyHome);
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      appendFileSync: sideEffect,
      mkdirSync: sideEffect,
      renameSync: sideEffect,
      rmSync: sideEffect,
      writeFileSync: sideEffect
    }));
    vi.doMock("node:fs/promises", () => ({
      appendFile: sideEffect,
      mkdir: sideEffect,
      rename: sideEffect,
      rm: sideEffect,
      writeFile: sideEffect
    }));
    vi.doMock("node:child_process", () => ({ exec: sideEffect, execFile: sideEffect, spawn: sideEffect }));
    vi.stubGlobal("fetch", sideEffect);
    vi.stubGlobal("WebSocket", sideEffect);
    let importTemporalTrap: TemporalImportTrap | undefined;
    let invocationTemporalTrap: TemporalInvocationTrap | undefined;
    let restoreDateNow: (() => void) | undefined;
    let restorePerformanceNow: (() => void) | undefined;
    try {
      importTemporalTrap = installTemporalImportTrap(globalThis);
      if (importTemporalTrap.mode === "absent") {
        expect(Reflect.get(globalThis, "Temporal")).toBeUndefined();
      } else if (importTemporalTrap.mode === "nonconfigurable") {
        expect(importTemporalTrap.nowMode).toBe("nonconfigurable");
      } else {
        expect(importTemporalTrap.nowMode === "trapped" || importTemporalTrap.nowMode === "nonconfigurable").toBe(true);
      }
      const imported = await import("../src/index.js");
      if (importTemporalTrap.mode === "trapped") {
        expect(importTemporalTrap.rootReads()).toBe(0);
        if (importTemporalTrap.nowMode === "trapped") {
          expect(importTemporalTrap.nowReads()).toBe(0);
        }
      }
      importTemporalTrap.restore();
      const dateNow = vi.spyOn(Date, "now");
      restoreDateNow = () => dateNow.mockRestore();
      const performanceNow = vi.spyOn(performance, "now");
      restorePerformanceNow = () => performanceNow.mockRestore();
      invocationTemporalTrap = installTemporalInvocationTrap(globalThis);
      if (invocationTemporalTrap.mode === "absent") {
        expect(Reflect.get(globalThis, "Temporal")).toBeUndefined();
      } else {
        expect(invocationTemporalTrap.mode).toBe("trapped");
      }
      const outcome = imported.evaluateSyntheticQuarantineJson(raw, FROZEN);
      expect(outcome.status).toBe("QUARANTINED");
      expect(sideEffect).not.toHaveBeenCalled();
      expect(dateNow).not.toHaveBeenCalled();
      expect(performanceNow).not.toHaveBeenCalled();
      expect(invocationTemporalTrap.reads()).toBe(0);
      expect(await readdir(emptyHome)).toEqual(before);
    } finally {
      invocationTemporalTrap?.restore();
      importTemporalTrap?.restore();
      restoreDateNow?.();
      restorePerformanceNow?.();
      vi.doUnmock("node:fs");
      vi.doUnmock("node:fs/promises");
      vi.doUnmock("node:child_process");
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await rm(emptyHome, { force: true, recursive: true });
    }
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
