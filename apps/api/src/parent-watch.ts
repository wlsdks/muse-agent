/// When Muse's desktop app spawns this server as a child, it passes its own PID
/// as MUSE_PARENT_PID. A child process is NOT killed if the parent dies
/// abnormally (crash / force-quit) — so we poll the parent and self-exit when it
/// is gone, preventing an orphaned server from lingering and holding the port.
/// No-op when MUSE_PARENT_PID is unset (a normal standalone `pnpm dev` server).
export function watchParentProcess(
  pidRaw: string | undefined = process.env.MUSE_PARENT_PID,
  intervalMs = 3000
): NodeJS.Timeout | undefined {
  const pid = Number(pidRaw);
  if (!pidRaw || !Number.isInteger(pid) || pid <= 1) return undefined;

  const timer = setInterval(() => {
    if (!isAlive(pid)) {
      // Parent gone — shut down so we don't orphan the port.
      process.exit(0);
    }
  }, intervalMs);
  // Don't keep the event loop alive solely for this watcher.
  timer.unref?.();
  return timer;
}

/// `kill(pid, 0)` sends no signal — it only checks for the process's existence.
/// Throws ESRCH when the pid is gone, EPERM when it exists but we can't signal
/// it (still alive).
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
