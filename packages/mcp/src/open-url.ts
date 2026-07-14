import { spawn } from "node:child_process";

/**
 * Open a URL in the user's default browser, cross-platform. `open` on macOS,
 * `start` on Windows, `xdg-open` elsewhere. Detached + unref'd so the CLI
 * process isn't tied to the browser's lifetime; stdio ignored so a launcher's
 * chatter never pollutes the terminal. Best-effort — a failed spawn is
 * swallowed because the login flow already prints the URL for a manual paste.
 */
export function openUrlInDefaultBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // best-effort — the URL is printed for manual open
  }
}
