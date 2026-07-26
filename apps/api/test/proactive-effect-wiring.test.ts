import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

function parseSource(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function callsNamed(source: ts.SourceFile, name: string): readonly ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function objectPropertyExpression(
  source: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  propertyName: string
): string | undefined {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property)
      && property.name.getText(source).replaceAll(/["']/gu, "") === propertyName
    ) {
      return property.initializer.getText(source);
    }
  }
  return undefined;
}

describe("proactive daemon durable-effect wiring", () => {
  it("uses the action-log sibling ledger and forwards it through the tick wrapper", () => {
    const daemonSource = parseSource("../src/tick-daemons.ts");
    const daemonCalls = callsNamed(daemonSource, "startProactiveTick");
    expect(daemonCalls).toHaveLength(1);
    const daemonOptions = daemonCalls[0]?.arguments[0];
    expect(daemonOptions !== undefined && ts.isObjectLiteralExpression(daemonOptions)).toBe(true);
    if (!daemonOptions || !ts.isObjectLiteralExpression(daemonOptions)) return;
    expect(objectPropertyExpression(daemonSource, daemonOptions, "effectFile")?.replaceAll(/\s+/gu, ""))
      .toBe('join(dirname(options.actionLogFile??resolveActionLogFile(env)),"outbound-effects.json")');

    const wrapperSource = parseSource("../src/proactive-tick.ts");
    const runCalls = callsNamed(wrapperSource, "runDueProactiveNotices");
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.arguments[0]!.getText(wrapperSource))
      .toContain("...(options.effectFile ? { effectFile: options.effectFile } : {})");
  });
});
