/**
 * `muse daemon` — run Muse's background daemons in one foreground
 * process the user can launch directly. This module is a thin re-export
 * hub; the implementation lives in cohesive siblings so every existing
 * `./commands-daemon.js` import keeps resolving:
 *
 *   - `commands-daemon-loop`        — the foreground loop primitives:
 *     the interruptible `DaemonStopSignal` and `runDaemonLoop`.
 *   - `commands-daemon-connections` — the best-effort default resolvers
 *     the daemon builds from env: the followup model, the Chrome DevTools
 *     snapshot connection (+ `chromeSnapshotConnectionFromTools`), and the
 *     ambient knowledge enricher.
 *   - `commands-daemon-register`    — the `daemon` command registration
 *     (commander wiring + option parsing) and every tick closure it drives,
 *     plus the `DaemonHelpers` test-seam interface.
 *   - `commands-daemon-launchagent` — the macOS LaunchAgent plist builder +
 *     file resolver, re-exported below.
 */

export { DaemonStopSignal, DEFAULT_DAEMON_INTERVAL_MS, runDaemonLoop } from "./commands-daemon-loop.js";
export { chromeSnapshotConnectionFromTools } from "./commands-daemon-connections.js";
export { type DaemonHelpers, installDaemonAutostart, registerDaemonCommands } from "./commands-daemon-register.js";
export { buildLaunchAgentPlist, parseLaunchctlListInfo, resolveLaunchAgentFile } from "./commands-daemon-launchagent.js";
