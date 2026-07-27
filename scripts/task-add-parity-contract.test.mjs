import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_ADD_OBSERVATION_SCHEMA,
  canonicalDigest,
  canonicalJson,
  isSha256,
  projectTaskAddObservation,
} from "./lib/task-add-parity-contract.mjs";

const beforeTask = {
  createdAt: "2026-07-20T00:00:00.000Z",
  id: "task_existing",
  status: "open",
  title: "Existing task",
};

const addedTask = {
  createdAt: "2026-07-27T01:02:03.000Z",
  dueAt: "2026-07-28T09:30:00.000Z",
  id: "task_generated_a",
  notes: "Keep  exact spacing",
  status: "open",
  tags: ["work", " Muse "],
  title: "Ship parity contract",
  urgent: true,
};

const successTerminals = {
  "cli-local": { exitCode: 0, kind: "cli", signal: null },
  api: { kind: "http", statusCode: 201 },
  web: { kind: "ui", requestCount: 1, submitEnabled: true },
};

const emptyTitleTerminals = {
  "cli-local": { exitCode: 2, kind: "cli", signal: null },
  api: { kind: "http", statusCode: 400 },
  web: { kind: "ui", requestCount: 0, submitEnabled: false },
};

test("canonical JSON and digest are stable under object-key reordering only", () => {
  const left = { z: [{ b: 2, a: 1 }], a: "value" };
  const right = { a: "value", z: [{ a: 1, b: 2 }] };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalDigest(left), canonicalDigest(right));
  assert.notEqual(canonicalDigest({ tags: ["a", "b"] }), canonicalDigest({ tags: ["b", "a"] }));
  assert.throws(() => canonicalJson({ bad: undefined }), /only JSON values/u);
});

test("CLI-local, API, and Web success share one canonical terminal, reason, and parity digest", () => {
  const projections = Object.entries(successTerminals).map(([surface, terminal], index) => {
    const generated = {
      ...addedTask,
      createdAt: `2026-07-27T01:02:0${(index + 3).toString()}.000Z`,
      id: `task_generated_${index.toString()}`,
    };
    return projectTaskAddObservation(observation({
      afterStore: [{ ...beforeTask, id: `existing_${index.toString()}` }, generated],
      beforeStore: [{ ...beforeTask, id: `existing_${index.toString()}` }],
      resultTask: generated,
      surface,
      terminal,
    }));
  });

  for (const projection of projections) {
    assert.equal(projection.verification, "verified");
    assert.equal(projection.terminal, "success");
    assert.equal(projection.reason, "task-added");
    assert.equal(projection.allowedEffectCount, 1);
    assert.ok(isSha256(projection.beforeStoreDigest));
    assert.ok(isSha256(projection.storeDigest));
    assert.ok(isSha256(projection.parityDigest));
    assert.deepEqual(projection.task, {
      completedAt: null,
      dueAt: addedTask.dueAt,
      notes: addedTask.notes,
      proactive: null,
      status: "open",
      tags: addedTask.tags,
      title: addedTask.title,
      urgent: true,
    });
    assert.equal(Object.hasOwn(projection.task, "id"), false);
    assert.equal(Object.hasOwn(projection.task, "createdAt"), false);
  }
  assert.equal(new Set(projections.map((projection) => projection.parityDigest)).size, 1);
});

test("generated id and createdAt never affect parity, while every task semantic does", () => {
  const baseline = projectTaskAddObservation(observation());
  const nondeterministicOnly = {
    ...addedTask,
    createdAt: "2026-07-27T22:33:44.000Z",
    id: "task_generated_other",
  };
  const nondeterministicProjection = projectTaskAddObservation(observation({
    afterStore: [beforeTask, nondeterministicOnly],
    resultTask: nondeterministicOnly,
  }));
  assert.equal(nondeterministicProjection.parityDigest, baseline.parityDigest);

  const drifts = [
    { ...addedTask, title: `${addedTask.title} ` },
    { ...addedTask, notes: `${addedTask.notes} ` },
    { ...addedTask, tags: [...addedTask.tags].reverse() },
    { ...addedTask, dueAt: "2026-07-29T09:30:00.000Z" },
    { ...addedTask, urgent: false },
    { ...addedTask, proactive: false },
    { ...addedTask, status: "done", completedAt: "2026-07-27T03:00:00.000Z" },
  ];
  for (const drifted of drifts) {
    const projected = projectTaskAddObservation(observation({
      afterStore: [beforeTask, drifted],
      resultTask: drifted,
    }));
    assert.equal(projected.verification, "verified");
    assert.notEqual(projected.parityDigest, baseline.parityDigest);
  }

  const completed = {
    ...addedTask,
    completedAt: "2026-07-27T03:00:00.000Z",
    status: "done",
  };
  const completedAtDrift = {
    ...completed,
    completedAt: "2026-07-27T03:00:01.000Z",
  };
  const completedProjection = projectTaskAddObservation(observation({
    afterStore: [beforeTask, completed],
    resultTask: completed,
  }));
  const completedAtProjection = projectTaskAddObservation(observation({
    afterStore: [beforeTask, completedAtDrift],
    resultTask: completedAtDrift,
  }));
  assert.equal(completedProjection.verification, "verified");
  assert.equal(completedAtProjection.verification, "verified");
  assert.notEqual(completedAtProjection.parityDigest, completedProjection.parityDigest);
});

test("CLI missing arg, API 400, and Web disabled submit share an empty-title no-effect contract", () => {
  const projections = Object.entries(emptyTitleTerminals).map(([surface, terminal]) =>
    projectTaskAddObservation(observation({
      afterStore: [beforeTask],
      allowedEffectCount: 0,
      beforeStore: [beforeTask],
      resultTask: null,
      scenario: "empty-title",
      surface,
      terminal,
    }))
  );

  for (const projection of projections) {
    assert.equal(projection.verification, "verified");
    assert.equal(projection.terminal, "user-error");
    assert.equal(projection.reason, "empty-title");
    assert.equal(projection.allowedEffectCount, 0);
    assert.equal(projection.beforeStoreDigest, projection.storeDigest);
    assert.equal(projection.task, null);
  }
  assert.equal(new Set(projections.map((projection) => projection.parityDigest)).size, 1);
});

test("malformed and unknown observations fail closed as unverified", () => {
  const extraKey = { ...observation(), unexpected: true };
  const malformedTask = observation({
    afterStore: [beforeTask, { ...addedTask, tags: ["valid", 42] }],
  });
  const unknownTerminal = observation({
    terminal: { exitCode: 9, kind: "cli", signal: null },
  });

  for (const input of [null, extraKey, malformedTask]) {
    const projection = projectTaskAddObservation(input);
    assert.equal(projection.verification, "unverified");
    assert.equal(projection.terminal, "unverified");
    assert.equal(projection.reason, "malformed-observation");
    assert.equal(projection.allowedEffectCount, null);
    assert.equal(projection.storeDigest, null);
  }

  const unknown = projectTaskAddObservation(unknownTerminal);
  assert.equal(unknown.verification, "unverified");
  assert.equal(unknown.terminal, "unverified");
  assert.equal(unknown.reason, "terminal-unrecognized");
  assert.equal(unknown.allowedEffectCount, 1);
  assert.ok(isSha256(unknown.storeDigest));
});

test("a terminal success cannot hide a collateral or miscounted effect", () => {
  const collateral = {
    ...observation(),
    afterStore: [{ ...beforeTask, title: "Silently changed" }, addedTask],
  };
  const miscounted = { ...observation(), allowedEffectCount: 2 };
  for (const input of [collateral, miscounted]) {
    const projection = projectTaskAddObservation(input);
    assert.equal(projection.verification, "unverified");
    assert.equal(projection.terminal, "unverified");
    assert.equal(projection.reason, "effect-contract-mismatch");
  }
});

function observation(overrides = {}) {
  return {
    afterStore: [beforeTask, addedTask],
    allowedEffectCount: 1,
    beforeStore: [beforeTask],
    resultTask: addedTask,
    scenario: "success",
    schemaVersion: TASK_ADD_OBSERVATION_SCHEMA,
    surface: "cli-local",
    terminal: successTerminals["cli-local"],
    ...overrides,
  };
}
