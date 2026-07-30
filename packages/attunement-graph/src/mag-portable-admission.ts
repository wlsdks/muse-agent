import {
  canonicalizeImmutableEnvelope,
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";
import type { MagStoredProjection } from "./mag-backend.js";
import type { MagScope } from "./mag-contracts.js";
import {
  normalizeMagScope,
  normalizeStoredProjection
} from "./mag-engine.js";
import { MagError } from "./mag-error.js";

const STORE_ENVELOPE_SPEC = Object.freeze({
  hashDomain: "muse.mag.store-projection.v1",
  idField: "storeEnvelopeId",
  idPrefix: "mag-store:"
} as const);

export interface AdmittedPortableProjection {
  readonly projection: MagStoredProjection;
  readonly identity: {
    readonly scope: MagScope;
    readonly generation: number;
    readonly commitId: string;
    readonly projectionId: `mag-store:${string}`;
  };
}

export function admitPortableProjection(
  value: unknown,
  expectedScope: MagScope
): AdmittedPortableProjection {
  const normalizedExpectedScope = normalizeMagScope(
    expectedScope,
    "portable projection expected scope"
  );
  const projection = normalizeStoredProjection(value, normalizedExpectedScope);
  const minted =
    mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
      projection,
      STORE_ENVELOPE_SPEC
    );
  const readmitted = canonicalizeImmutableEnvelope(
    minted.envelope,
    "muse-frozen",
    STORE_ENVELOPE_SPEC
  );
  if (
    readmitted.contentId !== minted.contentId
    || readmitted.canonicalJson !== minted.canonicalJson
    || readmitted.canonicalByteLength !== minted.canonicalByteLength
  ) {
    throw new MagError(
      "CORRUPT_STORE",
      "Portable projection store identity does not bind to its normalized projection"
    );
  }
  const scope = Object.freeze({
    sourceId: projection.snapshot.scope.sourceId,
    threadId: projection.snapshot.scope.threadId
  });
  const identity = Object.freeze({
    scope,
    generation: projection.snapshot.generation,
    commitId: projection.snapshot.commitId,
    projectionId: readmitted.contentId as `mag-store:${string}`
  });
  return Object.freeze({ projection, identity });
}
