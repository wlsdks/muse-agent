/**
 * `@muse/macos` — Muse's NATIVE macOS control tools. These are
 * in-process `MuseTool`s that spawn official Apple CLIs (osascript,
 * shortcuts, open, pmset, screencapture, pbcopy, mdfind) directly. They
 * are NOT MCP-protocol tools — the package is deliberately split out of
 * `@muse/mcp` so "Muse-own native tool" and "MCP plumbing" are separate.
 *
 * Depends only on `@muse/tools` (the MuseTool contract) and
 * `@muse/shared` — never on `@muse/mcp`. The outbound iMessage tool
 * takes its approval gate and action logger by INJECTION, so the
 * outbound-safety wiring lives at the CLI boundary, not here.
 */

export * from "./macos-tools.js";
export * from "./macos-reminders-mirror.js";
export * from "./macos-notes-mirror.js";
export * from "./macos-contacts-import.js";

export {
  MAC_HELPER_READS,
  MAC_HELPER_TIMEOUT_MS,
  readMacHelper,
  readMacWindows,
  type MacHelperDeps,
  type MacHelperRead,
  type MacHelperResult,
  type MacHelperWindow
} from "./macos-helper.js";

export {
  createMacObserveTool,
  MAC_OBSERVE_SOURCES,
  type MacObserveSource,
  type MacObserveToolDeps
} from "./macos-observe-tool.js";

export { MAC_HELPER_BINARY_NAME, resolveMacHelperPath } from "./macos-helper-path.js";
