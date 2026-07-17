import { AttunementStoreError, openContinuityDelivery, readAttunementState } from "./attunement-store.js";
import { buildContinuityPack } from "./continuity-pack.js";

import type { AttunementStoreOptions } from "./attunement-store.js";
import type { ContinuityDelivery, ContinuityPack, ExactArtifactResolver } from "./types.js";

export interface ContinuityFilePreparationOptions {
  readonly idFactory?: AttunementStoreOptions["idFactory"];
  /** Milliseconds since the Unix epoch. Read once per preparation. */
  readonly now?: () => number;
}

function capturePreparationTime(options: ContinuityFilePreparationOptions): number {
  const nowMs = (options.now ?? Date.now)();
  if (!Number.isFinite(nowMs)) throw new AttunementStoreError("continuity preparation clock returned an invalid time");
  return nowMs;
}

async function prepareAt(
  file: string,
  threadId: string,
  resolveExactArtifact: ExactArtifactResolver,
  nowMs: number
): Promise<ContinuityPack> {
  const state = await readAttunementState(file);
  return buildContinuityPack(state, threadId, resolveExactArtifact, nowMs);
}

/** Read-only preview path. It never creates a delivery receipt. */
export async function readPreparedContinuityPack(
  file: string,
  threadId: string,
  resolveExactArtifact: ExactArtifactResolver,
  options: ContinuityFilePreparationOptions = {}
): Promise<ContinuityPack> {
  const nowMs = capturePreparationTime(options);
  return prepareAt(file, threadId, resolveExactArtifact, nowMs);
}

/**
 * User-open path: read state, resolve exact sources, reject unavailable packs,
 * and policy-version-check the delivery while reusing one captured time.
 */
export async function openPreparedContinuityPack(
  file: string,
  threadId: string,
  resolveExactArtifact: ExactArtifactResolver,
  options: ContinuityFilePreparationOptions = {}
): Promise<{ readonly delivery: ContinuityDelivery; readonly pack: ContinuityPack }> {
  const nowMs = capturePreparationTime(options);
  const pack = await prepareAt(file, threadId, resolveExactArtifact, nowMs);
  if (pack.evidence.every((entry) => entry.status === "unavailable")) {
    throw new AttunementStoreError(`thread '${threadId}' has no currently available linked evidence; no delivery was recorded`);
  }
  const delivery = await openContinuityDelivery(file, {
    evidenceRefs: pack.evidenceRefs,
    expectedPolicyVersion: pack.deliveryPolicyVersion,
    threadId
  }, {
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    now: () => new Date(nowMs)
  });
  return { delivery, pack };
}

export type OpenPreparedContinuityPack = typeof openPreparedContinuityPack;
