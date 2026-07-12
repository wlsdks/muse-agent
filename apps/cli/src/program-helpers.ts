/**
 * Re-export barrel for the CLI's provider-neutral, chat-REPL-independent
 * infrastructure helpers. The implementation lives in four single-purpose
 * modules (split out so each responsibility can change independently):
 *
 *   - `program-http.ts`    — HTTP wire: `apiRequest`, `readSseEvents`,
 *     `streamRemoteChat`, error formatting, the local-fallback wrapper.
 *   - `program-config.ts`  — local config store + API-target resolution:
 *     `readConfigStore`/`writeConfigStore`, `readApiOptions`,
 *     `resolvePersona`, `firstNonEmpty`, plus small startup guards.
 *   - `program-auth.ts`    — interactive auth prompting: `resolveAuthToken`,
 *     `promptText`.
 *   - `program-output.ts`  — output shaping + run-log persistence:
 *     `writeOutput`, `renderActiveContext`, `writeRunLog`, `buildAskRunLog`.
 *
 * Dependency direction is one-way: `program-http.ts` depends on
 * `program-config.ts` + `program-output.ts`; neither of those (nor
 * `program-auth.ts`) depends back. Import from the specific module when
 * writing NEW code in this package; this barrel exists so the dozens of
 * existing call sites that import from `./program-helpers.js` keep
 * compiling unchanged.
 */

export * from "./program-http.js";
export * from "./program-config.js";
export * from "./program-auth.js";
export * from "./program-output.js";
