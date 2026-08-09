import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stdout } from "node:process";
import { URL } from "node:url";

import {
  orderFairFrontierBundles
} from "../dist/fair-frontier-bundle-order.js";

const lanes = ["continuity", "change", "evidence", "policy", "authority"];
const requestDomain =
  "muse.attunegraph.fair-frontier-bundle-order-request.v1";
const orderDomain = "muse.attunegraph.fair-frontier-bundle-order.v1";

function raw(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort(raw).map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`
  ).join(",")}}`;
}

function contentId(value, field, domain, prefix) {
  const body = JSON.parse(JSON.stringify(value));
  delete body[field];
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonical(body), "utf8")
    .digest("hex");
  return `${prefix}${digest}`;
}

function bundle(index) {
  return `muse-attunegraph-scoped-proof-document:sha256:${index.toString(16).padStart(64, "0")}`;
}

function opportunity(index, lane, minute) {
  return {
    bundleId: bundle(index),
    candidateId: `optional:${index.toString()}`,
    lane,
    observedAt: `2026-07-29T10:${minute.toString().padStart(2, "0")}:00.000Z`
  };
}

const scope = { sourceId: "dogfood", threadId: "thread-fairness" };
const snapshot = {
  authority: "caller-declared-read-snapshot",
  commitHash: `sha256:${"b".repeat(64)}`,
  commitSequence: 73,
  generationId: "generation:73"
};
const seed = { id: "thread-fairness", kind: "thread" };
const opportunities = [
  opportunity(8, "authority", 1),
  opportunity(3, "continuity", 3),
  opportunity(6, "evidence", 2),
  opportunity(2, "continuity", 4),
  opportunity(7, "policy", 1),
  opportunity(5, "change", 2),
  opportunity(1, "continuity", 5),
  opportunity(4, "change", 3)
];

function compare(left, right) {
  return Date.parse(right.observedAt) - Date.parse(left.observedAt)
    || raw(left.bundleId, right.bundleId)
    || raw(left.candidateId, right.candidateId);
}

function normalize(values) {
  return lanes.flatMap((lane) =>
    values.filter((item) => item.lane === lane).sort(compare)
  );
}

function semanticRequest(values) {
  const body = {
    operatorVersion: "muse.fair-frontier-bundle-order.v1",
    opportunities: normalize(values),
    schemaVersion: 1,
    scope,
    seed,
    snapshot
  };
  return {
    body,
    requestId: contentId(
      body,
      "requestId",
      requestDomain,
      "muse-attunegraph-fair-frontier-request:sha256:"
    )
  };
}

function independentOrder(values) {
  const normalized = normalize(values);
  const { requestId } = semanticRequest(values);
  const rotationOffset = normalized.length === 0
    ? 0
    : Number(BigInt(`0x${requestId.slice(-64, -48)}`) % 5n);
  const rotation = [...lanes.slice(rotationOffset), ...lanes.slice(0, rotationOffset)];
  const queues = new Map(lanes.map((lane) => [
    lane,
    normalized.filter((item) => item.lane === lane).sort(compare)
  ]));
  const entries = [];
  while (entries.length < normalized.length) {
    for (const lane of rotation) {
      const next = queues.get(lane).shift();
      if (next) entries.push({ ...next, rank: entries.length });
    }
  }
  const metrics = lanes.map((lane) => {
    const opportunityCount = normalized.filter((item) => item.lane === lane).length;
    if (opportunityCount === 0) {
      return { lane, opportunityCount: 0, orderedCount: 0 };
    }
    const ranks = entries.filter((item) => item.lane === lane).map((item) => item.rank);
    return {
      firstRank: ranks[0],
      lane,
      lastRank: ranks.at(-1),
      opportunityCount,
      orderedCount: ranks.length
    };
  });
  const body = {
    coverage: {
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      reasons: [
        "candidate-pool-only",
        "lane-semantics-caller-declared",
        "not-budget-settled"
      ],
      status: "partial"
    },
    entries,
    lanes: metrics,
    orderVersion: "muse.fair-frontier-bundle-order.v1",
    requestId,
    rotationOffset,
    schemaVersion: 1,
    scope,
    seed,
    snapshot
  };
  return {
    ...body,
    orderId: contentId(
      body,
      "orderId",
      orderDomain,
      "muse-attunegraph-fair-frontier-order:sha256:"
    )
  };
}

function fixture(values) {
  return {
    operatorVersion: "muse.fair-frontier-bundle-order.v1",
    opportunities: JSON.parse(JSON.stringify(values)),
    schemaVersion: 1,
    scope,
    seed,
    snapshot
  };
}

const expected = independentOrder(opportunities);
const actual = orderFairFrontierBundles(fixture(opportunities));
assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
assert.equal(
  actual.requestId,
  "muse-attunegraph-fair-frontier-request:sha256:1d026cadba49162f1dcfdf70c731e253d9faa0a8f015f212f3fef8ab41e699a3"
);
assert.equal(
  actual.orderId,
  "muse-attunegraph-fair-frontier-order:sha256:2d23c999af7d2a79b83f55044bd2ab30898f0457e9e7e57ba3537c356e56142b"
);

const admissionBody = fixture(opportunities);
const admissionId = contentId(
  admissionBody,
  "admissionId",
  "muse.attunegraph.fair-frontier-bundle-order-admission.v1",
  "muse-attunegraph-fair-frontier-admission:sha256:"
);
assert.throws(
  () => orderFairFrontierBundles({ ...admissionBody, admissionId }),
  (error) =>
    error?.code === "INVALID_REQUEST"
    && error?.details?.reason === "invalid-field-set"
    && error?.details?.path === "/admissionId"
);

for (let run = 0; run < 20; run += 1) {
  const permuted = [
    ...opportunities.slice(run % opportunities.length),
    ...opportunities.slice(0, run % opportunities.length)
  ];
  if (run % 2 === 1) permuted.reverse();
  assert.deepEqual(
    JSON.parse(JSON.stringify(orderFairFrontierBundles(fixture(permuted)))),
    expected
  );
}

const crowded = [
  ...Array.from({ length: 251 }, (_, index) =>
    opportunity(1000 + index, "continuity", index % 60)
  ),
  opportunity(2000, "change", 1),
  opportunity(2001, "evidence", 1),
  opportunity(2002, "policy", 1),
  opportunity(2003, "authority", 1)
];
const crowdedResult = orderFairFrontierBundles(fixture(crowded));
assert.deepEqual(
  new Set(crowdedResult.entries.slice(0, 5).map((entry) => entry.lane)),
  new Set(lanes)
);

const packageJson = JSON.parse(await readFile(
  new URL("../package.json", import.meta.url),
  "utf8"
));
assert.equal(packageJson.exports["./fair-frontier-bundle-order"], undefined);
assert.equal(Object.hasOwn(packageJson.exports, "."), false);

stdout.write(`${JSON.stringify({
  firstRound: actual.entries.slice(0, 5).map((entry) => entry.lane),
  orderId: actual.orderId,
  requestId: actual.requestId,
  status: "ok"
})}\n`);
