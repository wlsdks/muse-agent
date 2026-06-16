/**
 * `@muse/fs` — Muse's NATIVE local filesystem tools: in-process
 * `MuseTool`s that read, search, and (in later slices) write files on the
 * user's machine, the way Claude Code's Read/Glob/Grep/Write/Edit do.
 *
 * Every tool routes its paths through the deterministic path sandbox
 * (`fs-path-safety`): a broad allow-root (home dir by default) governed by
 * a fail-close deny-list for credential/key/secret material. The package
 * depends only on `@muse/tools` (the MuseTool contract) and `@muse/shared`
 * — never on a vendor SDK. Tools are opt-in at the CLI boundary
 * (`MUSE_FS_TOOLS`); the approval gate for write-tier tools is INJECTED
 * there, not here.
 */

export * from "./fs-document.js";
export * from "./fs-path-safety.js";
export * from "./fs-read-tools.js";
export * from "./fs-write-tools.js";
