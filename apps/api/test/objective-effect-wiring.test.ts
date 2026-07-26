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

describe("objectives daemon durable-effect wiring", () => {
  it("uses the action-log sibling ledger and forwards the terminal inspector", () => {
    const source = parseSource("../src/tick-daemons.ts");
    const actuatorCalls = callsNamed(source, "createMessagingObjectiveActuator");
    expect(actuatorCalls).toHaveLength(1);
    const actuatorOptions = actuatorCalls[0]?.arguments[0];
    expect(actuatorOptions !== undefined && ts.isObjectLiteralExpression(actuatorOptions)).toBe(true);
    if (!actuatorOptions || !ts.isObjectLiteralExpression(actuatorOptions)) return;
    expect(objectPropertyExpression(source, actuatorOptions, "effectFile"))
      .toBe('join(dirname(objectivesActionLogFile), "outbound-effects.json")');

    const tickCalls = callsNamed(source, "startObjectivesTick");
    expect(tickCalls).toHaveLength(1);
    const tickOptions = tickCalls[0]?.arguments[0];
    expect(tickOptions !== undefined && ts.isObjectLiteralExpression(tickOptions)).toBe(true);
    if (!tickOptions || !ts.isObjectLiteralExpression(tickOptions)) return;
    expect(objectPropertyExpression(source, tickOptions, "terminalEffects")).toBe("actuator");
  });
});
