import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordProactiveHeartbeat } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { DAEMON_INSTALL_OFFER_LINE, maybeOfferDaemonInstall, resolveDaemonOfferFile } from "./daemon-offer.js";

function tmpPaths(): { readonly plistFile: string; readonly offerFile: string; readonly heartbeatDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "muse-daemon-offer-"));
  return {
    heartbeatDir: dir,
    offerFile: join(dir, "daemon-offer-shown.json"),
    plistFile: join(dir, "com.muse.daemon.plist")
  };
}

describe("maybeOfferDaemonInstall — the one-time nudge toward `muse daemon --install`", () => {
  it("prints and persists the offer when self-learning is on, no plist exists, and the daemon has never fired (interactive TTY)", async () => {
    const { plistFile, offerFile, heartbeatDir } = tmpPaths();
    const printed: string[] = [];

    const shown = await maybeOfferDaemonInstall({
      env: {},
      heartbeatDir,
      isTTY: true,
      offerFile,
      plistFile,
      print: (line) => printed.push(line)
    });

    expect(shown).toBe(true);
    expect(printed).toEqual([DAEMON_INSTALL_OFFER_LINE]);
    expect(existsSync(offerFile)).toBe(true);
    expect((JSON.parse(readFileSync(offerFile, "utf8")) as { offered: boolean }).offered).toBe(true);
  });

  it("never prints twice — the second call is a no-op once the offer file is written", async () => {
    const { plistFile, offerFile, heartbeatDir } = tmpPaths();
    const printed: string[] = [];
    const print = (line: string): void => { printed.push(line); };

    const first = await maybeOfferDaemonInstall({ env: {}, heartbeatDir, isTTY: true, offerFile, plistFile, print });
    const second = await maybeOfferDaemonInstall({ env: {}, heartbeatDir, isTTY: true, offerFile, plistFile, print });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(printed).toHaveLength(1);
  });

  it("does not print when a LaunchAgent plist already exists", async () => {
    const { plistFile, offerFile, heartbeatDir } = tmpPaths();
    writeFileSync(plistFile, "<plist/>", "utf8");
    const printed: string[] = [];

    const shown = await maybeOfferDaemonInstall({
      env: {}, heartbeatDir, isTTY: true, offerFile, plistFile, print: (line) => printed.push(line)
    });

    expect(shown).toBe(false);
    expect(printed).toHaveLength(0);
    expect(existsSync(offerFile)).toBe(false);
  });

  it("does not print when self-learning is explicitly off", async () => {
    const { plistFile, offerFile, heartbeatDir } = tmpPaths();
    const printed: string[] = [];

    const shown = await maybeOfferDaemonInstall({
      env: { MUSE_SELFLEARN_ENABLED: "false" },
      heartbeatDir, isTTY: true, offerFile, plistFile,
      print: (line) => printed.push(line)
    });

    expect(shown).toBe(false);
    expect(printed).toHaveLength(0);
  });

  it("does not print while the daemon heartbeat is currently HEALTHY (alive + fired both fresh)", async () => {
    const { plistFile, offerFile, heartbeatDir } = tmpPaths();
    await recordProactiveHeartbeat(heartbeatDir, "alive");
    await recordProactiveHeartbeat(heartbeatDir, "fired");
    const printed: string[] = [];

    const shown = await maybeOfferDaemonInstall({
      env: {}, heartbeatDir, isTTY: true, offerFile, plistFile, print: (line) => printed.push(line)
    });

    expect(shown).toBe(false);
    expect(printed).toHaveLength(0);
  });

  it("DOES print once a stale heartbeat goes past the alive-stale threshold — a dead daemon doesn't suppress forever", async () => {
    const { plistFile, offerFile, heartbeatDir } = tmpPaths();
    // A mark from far in the past (e.g. the daemon ran once, then died) — under
    // the OLD bare-truthiness check this would suppress the offer PERMANENTLY,
    // even though the daemon is long dead. classifyProactiveHeartbeat's age
    // check must reclassify this as non-healthy so the offer fires again.
    const longAgo = () => new Date("2020-01-01T00:00:00Z");
    await recordProactiveHeartbeat(heartbeatDir, "alive", longAgo);
    await recordProactiveHeartbeat(heartbeatDir, "fired", longAgo);
    const printed: string[] = [];

    const shown = await maybeOfferDaemonInstall({
      env: {}, heartbeatDir, isTTY: true, now: () => new Date(), offerFile, plistFile, print: (line) => printed.push(line)
    });

    expect(shown).toBe(true);
    expect(printed).toEqual([DAEMON_INSTALL_OFFER_LINE]);
  });

  it("does NOT persist the marker on a non-TTY run (e.g. piped stderr) — a scripted run doesn't burn the one lifetime offer", async () => {
    const { plistFile, offerFile, heartbeatDir } = tmpPaths();
    const printed: string[] = [];

    const shown = await maybeOfferDaemonInstall({
      env: {}, heartbeatDir, isTTY: false, offerFile, plistFile, print: (line) => printed.push(line)
    });

    expect(shown).toBe(true); // it DID print
    expect(printed).toEqual([DAEMON_INSTALL_OFFER_LINE]);
    expect(existsSync(offerFile)).toBe(false); // but the marker was NOT persisted

    // So a later, interactive run still gets the offer.
    const second = await maybeOfferDaemonInstall({
      env: {}, heartbeatDir, isTTY: true, offerFile, plistFile, print: (line) => printed.push(line)
    });
    expect(second).toBe(true);
    expect(existsSync(offerFile)).toBe(true);
  });

  it("refuses by construction under vitest when no offerFile/heartbeatDir/plistFile is explicitly injected — never touches the ambient env.HOME", async () => {
    const printed: string[] = [];

    // No offerFile/heartbeatDir/plistFile passed — mirrors exactly how
    // program.ts / commands-ask.ts call this in production (with the
    // ambient process.env). Under vitest this must be a pure no-op instead
    // of resolving against a real (or accidentally-real) HOME.
    const shown = await maybeOfferDaemonInstall({ env: {}, print: (line) => printed.push(line) });

    expect(shown).toBe(false);
    expect(printed).toHaveLength(0);
  });

  it("resolveDaemonOfferFile honors MUSE_DAEMON_OFFER_FILE and falls back under HOME/.muse", () => {
    expect(resolveDaemonOfferFile({ MUSE_DAEMON_OFFER_FILE: "/tmp/custom-offer.json" })).toBe("/tmp/custom-offer.json");
    expect(resolveDaemonOfferFile({ HOME: "/Users/test" })).toBe(join("/Users/test", ".muse", "daemon-offer-shown.json"));
  });
});
