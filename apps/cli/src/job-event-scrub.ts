/**
 * Goal 116 — credential hygiene for `~/.muse/jobs/<id>.jsonl`.
 *
 * `muse job run` persists user `prompt` + LLM `text` verbatim to
 * a per-job JSONL log. Same long-lived-on-disk + replay-into-model
 * concern goal 108 closed for `~/.muse/last-chat.jsonl`. This
 * helper sits between the job worker and the file write so an
 * `sk-`/`ghp-`/etc. in either the user's prompt or the model's
 * output never reaches disk verbatim.
 *
 * Carved into its own module (vs. inlining in job-worker.ts)
 * because the worker file runs `main()` at top level — tests
 * importing it would spawn the worker. Pure helper here =
 * direct unit-test coverage with no side effects.
 */

import { redactSecretsInText } from "@muse/shared";

/**
 * Fields the job-worker writes as JSONL event payloads that may
 * carry user-typed text or LLM output. Kept narrow on purpose:
 * scrubbing structural fields like `tsIso` / `type` / `userKey` /
 * `model` is unnecessary and would also strip a legitimate
 * matching ID if one ever happened to look credential-shaped.
 */
const REDACT_FIELDS: ReadonlySet<string> = new Set(["prompt", "text"]);

/**
 * Returns a shallow-cloned event with `prompt` + `text` scrubbed
 * via `redactSecretsInText`. Non-string values, and string values
 * outside the allowlist, pass through unchanged.
 */
export function scrubJobEvent(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === "string" && REDACT_FIELDS.has(key)) {
      out[key] = redactSecretsInText(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
