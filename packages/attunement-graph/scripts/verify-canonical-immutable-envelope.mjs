/* global Buffer, console */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { types } from "node:util";

import {
  CanonicalImmutableEnvelopeError,
  canonicalizeImmutableEnvelope
} from "../dist/canonical-immutable-envelope.js";
import * as root from "@muse/attunement-graph";

const spec = Object.freeze({
  hashDomain: "muse.attunement-graph.awg-045a.fixture.v1",
  idField: "envelopeId",
  idPrefix: "muse-envelope:test:sha256:"
});
const unsignedJson = "{\"-1\":\"minus\",\"01\":\"leading\",\"1\":\"one\",\"10\":\"ten\",\"2\":\"two\",\"4294967294\":\"max-index\",\"4294967295\":\"not-index\",\"a\":[\"quote\\\"\",\"line\\n\",\"한글\",{\"😀\":\"astral\",\"\":\"private\"}]}";
const digest = "19dbf32f16b4514c484979ba95fb1d7faa9c5cacbaa138acb686fb56ad7700f1";
const contentId = `muse-envelope:test:sha256:${digest}`;
const fullJson = `{"-1":"minus","01":"leading","1":"one","10":"ten","2":"two","4294967294":"max-index","4294967295":"not-index","a":["quote\\"","line\\n","한글",{"😀":"astral","":"private"}],"envelopeId":"${contentId}"}`;
const fullHex = "7b222d31223a226d696e7573222c223031223a226c656164696e67222c2231223a226f6e65222c223130223a2274656e222c2232223a2274776f222c2234323934393637323934223a226d61782d696e646578222c2234323934393637323935223a226e6f742d696e646578222c2261223a5b2271756f74655c22222c226c696e655c6e222c22ed959ceab880222c7b22f09f9880223a2261737472616c222c22ee8080223a2270726976617465227d5d2c22656e76656c6f70654964223a226d7573652d656e76656c6f70653a746573743a7368613235363a31396462663332663136623435313463343834393739626139356662316437666161396335636163626161313338616362363836666235366164373730306631227d";
const expectedRootExports = [
  "ACTIVATION_PREDICATES",
  "AttunementGraphError",
  "GRAPH_ASSERTION_SOURCE_NAMESPACE",
  "GRAPH_DERIVATION_KINDS",
  "GRAPH_DIRECTIONS",
  "GRAPH_EPISTEMIC_CLASSES",
  "GRAPH_NODE_KINDS",
  "GRAPH_PREDICATES",
  "InMemoryAttunementGraphStore",
  "MAX_ACTIVATION_ESTIMATED_TOKENS",
  "MAX_GRAPH_APPEND_BATCH_ASSERTIONS",
  "MAX_GRAPH_ASSERTION_SOURCE_REFS",
  "MAX_GRAPH_QUERY_ASSERTIONS",
  "MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS",
  "MAX_GRAPH_QUERY_DEPTH",
  "MAX_GRAPH_QUERY_SEEDS",
  "MAX_GRAPH_QUERY_VISITED_REFS",
  "compileActivationSubgraph"
];

function mutableFixture() {
  const nested = {};
  nested[""] = "private";
  nested["😀"] = "astral";
  const value = {};
  value.a = ["quote\"", "line\n", "한글", nested];
  value["4294967295"] = "not-index";
  value["4294967294"] = "max-index";
  value["2"] = "two";
  value["10"] = "ten";
  value["1"] = "one";
  value["01"] = "leading";
  value["-1"] = "minus";
  return value;
}

function frozenCopy(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      value: frozenCopy(value[key]),
      writable: false
    });
  }
  return Object.freeze(output);
}

assert.equal(Buffer.byteLength(unsignedJson), 178);
assert.equal(Buffer.byteLength(fullJson), 284);
assert.equal(
  createHash("sha256").update(spec.hashDomain, "utf8").update("\0").update(unsignedJson, "utf8").digest("hex"),
  digest
);

const mutable = mutableFixture();
const mutableResult = canonicalizeImmutableEnvelope(mutable, "external-mutable", spec);
const frozen = frozenCopy({ ...mutableFixture(), envelopeId: contentId });
const frozenResult = canonicalizeImmutableEnvelope(frozen, "muse-frozen", spec);
for (const result of [mutableResult, frozenResult]) {
  assert.equal(result.canonicalJson, fullJson);
  assert.equal(result.canonicalByteLength, 284);
  assert.equal(result.contentId, contentId);
  assert.equal(Buffer.from(result.canonicalJson).toString("hex"), fullHex);
  assert.equal(Object.getPrototypeOf(result.envelope), null);
  assert.equal(Object.isFrozen(result.envelope), true);
}
assert.notEqual(mutableResult.envelope, frozenResult.envelope);

let traps = 0;
const proxy = new Proxy({}, {
  ownKeys() {
    traps += 1;
    throw new Error("must not run");
  }
});
assert.equal(types.isProxy(proxy), true);
assert.throws(
  () => canonicalizeImmutableEnvelope(proxy, "external-mutable", spec),
  (error) => error instanceof CanonicalImmutableEnvelopeError
    && error.code === "INVALID_INPUT"
    && error.details.reason === "proxy"
);
assert.equal(traps, 0);

assert.deepEqual(Object.keys(root).sort(), expectedRootExports);
await assert.rejects(
  import("@muse/attunement-graph/canonical-immutable-envelope"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
);

console.log("canonical immutable envelope golden and boundary probes passed");
