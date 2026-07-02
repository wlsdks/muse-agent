/**
 * Council deliberation — the public surface. This module is a thin re-export hub;
 * the implementation lives in cohesive siblings:
 *
 *   - `council-consensus`  — utterance model, per-member support (Jaccard +
 *     semantic cosine), the ReConcile/ConfMAD consensus gates + their thresholds.
 *   - `council-debate`     — cross-round debate: progress guard, conformity-flip
 *     detection, and the round-2+ debate-question builder.
 *   - `council-screening`  — outlier / off-topic / echo / unfaithful-contributor /
 *     dissent screens that clean the panel before synthesis.
 *   - `council-synthesis`  — the two bounded local-model steps (produce reasoning,
 *     synthesise the grounded answer) plus the RGV re-verification gate.
 */

export * from "./council-consensus.js";
export * from "./council-debate.js";
export * from "./council-screening.js";
export * from "./council-synthesis.js";
