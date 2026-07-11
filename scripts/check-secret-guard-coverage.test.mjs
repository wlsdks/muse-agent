import assert from "node:assert/strict";
import { test } from "node:test";

import { findViolations, splitIntoToolSegments } from "./lib/secret-guard-coverage.mjs";

const GUARDED_TOOL = `
      {
        description: "add",
        execute: async (args) => {
          const title = readString(args, "title");
          const notes = readString(args, "notes");
          const guard = assertNoSecretInPersistedFields({ title, notes });
          if (!guard.safe) return { blocked: true };
          return { ok: true };
        },
        inputSchema: {},
        name: "add",
        risk: "write"
      },
`;

const UNGUARDED_TOOL = `
      {
        description: "add",
        execute: async (args) => {
          const title = readString(args, "title");
          const notes = readString(args, "notes");
          return { ok: true };
        },
        inputSchema: {},
        name: "add",
        risk: "write"
      },
`;

const READ_ONLY_TOOL = `
      {
        description: "list",
        execute: async (args) => {
          const title = readString(args, "title");
          return { ok: true };
        },
        inputSchema: {},
        name: "list",
        risk: "read"
      },
`;

const WRITE_NO_FREE_TEXT_TOOL = `
      {
        description: "complete",
        execute: async (args) => {
          const id = readString(args, "id");
          return { ok: true };
        },
        inputSchema: {},
        name: "complete",
        risk: "write"
      },
`;

test("findViolations: flags a risk:write tool that reads a free-text field and never calls the guard", () => {
  const violations = findViolations("fixture.ts", UNGUARDED_TOOL);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].tool, "add");
});

test("findViolations: a guarded write tool is clean", () => {
  assert.deepEqual(findViolations("fixture.ts", GUARDED_TOOL), []);
});

test("findViolations: a read-only tool reading free text is not flagged (no persistence)", () => {
  assert.deepEqual(findViolations("fixture.ts", READ_ONLY_TOOL), []);
});

test("findViolations: a write tool with no free-text field (id-only) is not flagged", () => {
  assert.deepEqual(findViolations("fixture.ts", WRITE_NO_FREE_TEXT_TOOL), []);
});

test("findViolations: multi-tool file only flags the specific unguarded tool, not its siblings", () => {
  const combined = GUARDED_TOOL + UNGUARDED_TOOL.replace('name: "add"', 'name: "update"');
  const violations = findViolations("fixture.ts", combined);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].tool, "update");
});

test("splitIntoToolSegments: a single-execute file (MuseTool shape) returns the whole file as one segment", () => {
  const singleTool = `
    export function createThing() {
      return {
        definition: { name: "remember_fact", risk: "write" },
        execute: async (args) => {
          const key = readString(args, "key");
          const value = readString(args, "value");
          return {};
        }
      };
    }
  `;
  const segments = splitIntoToolSegments(singleTool);
  assert.equal(segments.length, 1);
  assert.equal(segments[0], singleTool);
  // and the whole-file segment DOES carry risk:"write" even though it
  // precedes `execute:` in source order — this is the case a naive
  // "everything after execute:" split would miss.
  const violations = findViolations("fixture.ts", singleTool);
  assert.equal(violations.length, 1);
});

test("splitIntoToolSegments: no execute occurrences returns no segments", () => {
  assert.deepEqual(splitIntoToolSegments("export const x = 1;"), []);
});
